import type { Page } from '@playwright/test';

export interface ProofClock { epoch: number; monotonic: number; wall: number }
export const proofClock = (): ProofClock => {
  const monotonic = performance.now();
  return { epoch: performance.timeOrigin + monotonic, monotonic, wall: Date.now() };
};
export interface TransferPhase { id: number; label: string; reset: ProofClock }
export interface TransferRequest { id: number; phaseId: number; opened: ProofClock; start: number; end: number }
export interface TransferChunk {
  sequence: number; requestId: number; phaseId: number; start: number; end: number;
  before: ProofClock; after?: ProofClock;
}
export interface TransferTimeline {
  captured: ProofClock; receipt: ByteReceipt; phases: TransferPhase[]; requests: TransferRequest[]; chunks: TransferChunk[];
}
export interface ByteReceipt { phaseId: number; bytes: number; requests: number; sampled: ProofClock }
export interface DomFrame { page: number; ms: number; phaseId: number; epoch: number; deliveredEpoch: number }
export interface ClockAlignment {
  before: ProofClock; after: ProofClock;
  browser: { epoch: number; wall: number; quantumMs: number | null };
}

export async function alignClock(page: Page): Promise<ClockAlignment> {
  const before = proofClock();
  const browser = await page.evaluate(() => {
    let previous = performance.now(), quantumMs: number | null = null;
    for (let i = 0; i < 100000; i++) {
      const next = performance.now();
      if (next > previous) quantumMs = Math.min(quantumMs ?? Infinity, next - previous);
      previous = next;
    }
    return { epoch: performance.timeOrigin + performance.now(), wall: Date.now(), quantumMs };
  });
  return { before, browser, after: proofClock() };
}

const invalid = (reason: string): never => { throw new Error(`CBZ byte proof inconclusive: ${reason}`); };
const requireProof = (condition: boolean, reason: string): void => { if (!condition) invalid(reason); };

export function domByteBound(frame: DomFrame, receipt: ByteReceipt, alignment: ClockAlignment[], timeline: TransferTimeline) {
  requireProof(alignment.length >= 4, 'before/after clock brackets missing');
  for (const sample of alignment) requireProof(sample.browser.quantumMs !== null &&
    Number.isFinite(sample.browser.quantumMs) && sample.browser.quantumMs > 0, 'unknown browser clock resolution');
  const marginMs = Math.max(5, ...alignment.map(sample => 2 * sample.browser.quantumMs!));
  const origin = alignment[0].before.epoch - alignment[0].before.monotonic;
  const clock = (value: ProofClock) => requireProof(
    [value.epoch, value.monotonic, value.wall].every(Number.isFinite) &&
    Math.abs(value.wall - value.epoch) <= marginMs && Math.abs(value.epoch - value.monotonic - origin) <= 1,
    'invalid or discontinuous provider clock');
  const intervals = alignment.map(sample => {
    clock(sample.before); clock(sample.after);
    requireProof(Number.isFinite(sample.browser.epoch) && Number.isFinite(sample.browser.wall) &&
      Math.abs(sample.browser.wall - sample.browser.epoch) <= marginMs &&
      sample.before.epoch <= sample.after.epoch, 'invalid clock bracket');
    return { low: sample.before.epoch - sample.browser.epoch - marginMs,
      high: sample.after.epoch - sample.browser.epoch + marginMs };
  });
  requireProof(Math.max(...intervals.map(value => value.low)) <= Math.min(...intervals.map(value => value.high)),
    'clock brackets have no common offset');
  requireProof(alignment.filter(sample => sample.browser.epoch < frame.epoch).length >= 2 &&
    alignment.filter(sample => sample.browser.epoch > frame.epoch).length >= 2, 'DOM event not bracketed');
  const earliest = frame.epoch + Math.min(...intervals.map(value => value.low));
  const latest = frame.epoch + Math.max(...intervals.map(value => value.high));
  clock(receipt.sampled); clock(timeline.captured); clock(timeline.receipt.sampled);
  requireProof([frame.epoch, frame.deliveredEpoch, frame.ms, receipt.bytes].every(Number.isFinite) &&
    frame.ms >= 0 && frame.deliveredEpoch >= frame.epoch && Number.isSafeInteger(frame.page) && frame.page > 0 &&
    Number.isSafeInteger(receipt.bytes) && receipt.bytes >= 0 && Number.isSafeInteger(receipt.requests) && receipt.requests >= 0,
    'invalid frame or receipt');
  requireProof(receipt.sampled.epoch >= frame.deliveredEpoch + Math.min(...intervals.map(value => value.low)),
    'receipt precedes browser delivery');
  requireProof(receipt.phaseId === frame.phaseId && timeline.receipt.phaseId === frame.phaseId &&
    timeline.receipt.sampled.epoch === timeline.captured.epoch && timeline.captured.epoch >= latest &&
    timeline.captured.epoch >= receipt.sampled.epoch, 'counter reset or incomplete event coverage');
  const phases = new Map(timeline.phases.map(phase => [phase.id, phase]));
  requireProof(phases.size === timeline.phases.length, 'duplicate phase IDs');
  timeline.phases.forEach((phase, index) => {
    clock(phase.reset);
    requireProof(phase.id === index + 1 && phase.reset.epoch <= timeline.captured.epoch &&
      (!index || phase.reset.epoch >= timeline.phases[index - 1].reset.epoch),
      'phase timeline gap');
  });
  const phase = phases.get(frame.phaseId);
  if (!phase) return invalid('phase missing');
  requireProof(phase.reset.epoch <= earliest, 'DOM event precedes phase reset');
  const requests = new Map(timeline.requests.map(request => [request.id, request]));
  requireProof(requests.size === timeline.requests.length, 'duplicate request IDs');
  timeline.requests.forEach((request, index) => {
    clock(request.opened);
    requireProof(request.id === index + 1 && phases.has(request.phaseId) &&
      Number.isSafeInteger(request.start) && Number.isSafeInteger(request.end) &&
      request.start >= 0 && request.end > request.start && request.opened.epoch <= timeline.captured.epoch &&
      [...timeline.phases].reverse().find(phase => phase.reset.epoch <= request.opened.epoch)?.id === request.phaseId,
    'request timeline gap');
  });
  const offsets = new Map<number, number>();
  let receiptBytes = 0, capturedBytes = 0, upperBytes = 0, priorJobUpperBytes = 0, previousEnd = -Infinity;
  timeline.chunks.forEach((chunk, index) => {
    clock(chunk.before);
    if (!chunk.after) return invalid('unfinished chunk timestamp');
    clock(chunk.after);
    const request = requests.get(chunk.requestId);
    if (!request) return invalid('chunk request missing');
    requireProof(chunk.sequence === index + 1 && phases.has(chunk.phaseId) &&
      chunk.start === (offsets.get(request.id) ?? request.start) &&
      Number.isSafeInteger(chunk.end) && chunk.end > chunk.start && chunk.end <= request.end &&
      chunk.before.epoch >= previousEnd && chunk.after.epoch >= chunk.before.epoch &&
      chunk.before.epoch >= request.opened.epoch && chunk.after.epoch <= timeline.captured.epoch,
    'chunk timeline gap or invalid order');
    previousEnd = chunk.after.epoch; offsets.set(request.id, chunk.end);
    const emittedPhase = [...timeline.phases].reverse().find(value => value.reset.epoch <= chunk.before.epoch);
    requireProof(emittedPhase?.id === chunk.phaseId, 'chunk reset attribution differs');
    const bytes = chunk.end - chunk.start;
    if (chunk.phaseId === receipt.phaseId && chunk.before.epoch <= receipt.sampled.epoch) receiptBytes += bytes;
    if (chunk.phaseId === timeline.receipt.phaseId) capturedBytes += bytes;
    // Charge every post-reset chunk, even when its request belongs to an abandoned older job.
    if (chunk.after.epoch >= phase.reset.epoch && chunk.before.epoch <= latest) {
      upperBytes += bytes;
      if (request.phaseId !== phase.id) priorJobUpperBytes += bytes;
    }
  });
  requireProof(receiptBytes === receipt.bytes && capturedBytes === timeline.receipt.bytes &&
    timeline.requests.filter(request => request.phaseId === receipt.phaseId &&
      request.opened.epoch <= receipt.sampled.epoch).length === receipt.requests &&
    timeline.requests.filter(request => request.phaseId === timeline.receipt.phaseId).length === timeline.receipt.requests,
  'receipt/timeline accounting gap');
  return { upperBytes, priorJobUpperBytes, originalReceiptBytes: receipt.bytes,
    clock: { earliest, latest, uncertaintyMs: latest - earliest, marginMs },
    method: 'All post-reset queued body chunks through latest possible DOM event; whole boundary chunks included. Not TCP-wire bytes.' };
}
