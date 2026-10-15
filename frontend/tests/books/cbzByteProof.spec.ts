import { test, expect } from '@playwright/test';
import { domByteBound, ByteReceipt, ClockAlignment, DomFrame, ProofClock, TransferTimeline } from './cbzByteProof';

const clock = (epoch: number): ProofClock => ({ epoch, monotonic: epoch, wall: epoch });
function fixture() {
  const frame: DomFrame = { page: 243, ms: 100, phaseId: 2, epoch: 200, deliveredEpoch: 400 };
  const receipt: ByteReceipt = { phaseId: 2, bytes: 600, requests: 1, sampled: clock(500) };
  const alignment: ClockAlignment[] = [120, 130, 600, 610].map(epoch => ({
    before: clock(epoch), browser: { epoch: epoch + 1, wall: epoch + 1, quantumMs: 1 }, after: clock(epoch + 2),
  }));
  const timeline: TransferTimeline = {
    captured: clock(650),
    receipt: { ...receipt, sampled: clock(650) },
    phases: [{ id: 1, label: 'old', reset: clock(10) }, { id: 2, label: 'resume', reset: clock(100) }],
    requests: [{ id: 1, phaseId: 1, opened: clock(80), start: 0, end: 100 },
      { id: 2, phaseId: 2, opened: clock(140), start: 0, end: 500 }],
    chunks: [
      { sequence: 1, requestId: 1, phaseId: 2, start: 0, end: 100, before: clock(180), after: clock(181) },
      { sequence: 2, requestId: 2, phaseId: 2, start: 0, end: 200, before: clock(204), after: clock(205) },
      { sequence: 3, requestId: 2, phaseId: 2, start: 200, end: 500, before: clock(220), after: clock(221) },
    ],
  };
  return { frame, receipt, alignment, timeline };
}
test('DOM byte bound includes prior-job traffic and the entire uncertain boundary chunk', () => {
  const f = fixture();
  expect(domByteBound(f.frame, f.receipt, f.alignment, f.timeline)).toMatchObject({
    upperBytes: 300, priorJobUpperBytes: 100, originalReceiptBytes: 600,
    clock: { earliest: 194, latest: 206, uncertaintyMs: 12 },
  });
});
test('later observer receipt does not move the DOM-event byte boundary', () => {
  const f = fixture();
  const early = { ...f.receipt, bytes: 300, sampled: clock(210) };
  expect(domByteBound({ ...f.frame, deliveredEpoch: 200 }, early, f.alignment, f.timeline).upperBytes).toBe(300);
  expect(domByteBound(f.frame, f.receipt, f.alignment, f.timeline).upperBytes).toBe(300);
});
test('invalid alignment and missing provider evidence fail explicitly instead of undercounting', () => {
  const mutations: Array<(value: ReturnType<typeof fixture>) => void> = [
    f => { f.alignment[0].browser.quantumMs = null; },
    f => { f.alignment[0].browser.epoch += 100; f.alignment[0].browser.wall += 100; },
    f => { f.timeline.chunks.splice(0, 1); },
    f => { f.timeline.chunks[1].start = 1; },
    f => { f.timeline.chunks[0].requestId = 99; },
    f => { f.timeline.captured = clock(203); },
    f => { f.receipt.bytes = 599; },
    f => { f.receipt.phaseId = 1; },
    f => { f.frame.deliveredEpoch = 200; f.receipt = { ...f.receipt, bytes: 300, sampled: clock(210) }; f.timeline.chunks.pop(); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    expect(() => domByteBound(f.frame, f.receipt, f.alignment, f.timeline)).toThrow(/CBZ byte proof inconclusive/);
  }
});
