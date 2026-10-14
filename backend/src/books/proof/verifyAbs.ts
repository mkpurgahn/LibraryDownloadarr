import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { AbsClient } from '../absClient';
import { BooksRepository } from '../repository';
import { boundedQuery, providerOrigin } from '../limits';
import https from 'node:https';
import { IncomingHttpHeaders } from 'node:http';
import { BookItem } from '../types';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ConsumerFixtureManifest {
  schemaVersion: 1;
  kind: 'independent-abs';
  runId: string;
  absVersion: '2.30.0';
  serverBindingProofId: string;
  providerInstanceId: string;
  libraryId: string;
  files: Array<{
    absItemId: string; absIno: string; relativePath: string; role: 'ebook' | 'audio';
    size: number; sha256: string; manifestVersion: string; expectedText?: string;
  }>;
}
type NormalizedFixture = Omit<ConsumerFixtureManifest, 'kind' | 'providerInstanceId'> & {
  providerInstanceId?: string;
  kind: 'independent-abs' | 'seekr-handoff';
};
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid fixture manifest');
  return input as Record<string, unknown>;
};
const identity = (input: unknown): string => {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input)) throw new Error('Invalid fixture identity');
  return input;
};

export function normalizeFixtureManifest(input: unknown): NormalizedFixture {
  const raw = record(input);
  if (raw.schemaVersion !== 1) throw new Error('Unsupported fixture schema version');
  let files: unknown;
  let libraryId: unknown;
  let bindingId: unknown;
  let providerId: unknown;
  let kind: NormalizedFixture['kind'];
  if (raw.kind === 'independent-abs') {
    if (Object.keys(raw).some(key => !['schemaVersion', 'kind', 'runId', 'absVersion', 'serverBindingProofId', 'providerInstanceId', 'libraryId', 'files'].includes(key)) ||
        raw.absVersion !== '2.30.0') throw new Error('Invalid independent fixture manifest');
    kind = 'independent-abs'; files = raw.files; libraryId = raw.libraryId;
    bindingId = raw.serverBindingProofId; providerId = identity(raw.providerInstanceId);
  } else {
    if (Object.keys(raw).some(key => !['schemaVersion', 'runId', 'revisions', 'services', 'binding', 'jobs', 'preservationEvidence'].includes(key))) throw new Error('Invalid joined fixture manifest');
    const services = record(raw.services);
    const binding = record(raw.binding);
    if (services.absVersion !== '2.30.0' || services.qbitVersion !== '5.1.3' || !Array.isArray(raw.jobs)) throw new Error('Invalid fixture service versions');
    kind = 'seekr-handoff';
    files = raw.jobs.flatMap(job => {
      const row = record(job);
      if (!Array.isArray(row.files)) throw new Error('Invalid fixture job files');
      return row.files;
    });
    libraryId = binding.libraryId; bindingId = binding.serverBindingProofId;
    providerId = binding.ldaProviderInstanceId;
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 10000) throw new Error('Invalid fixture file count');
  const seen = new Set<string>();
  const normalized = files.map<ConsumerFixtureManifest['files'][number]>(value => {
    const file = record(value);
    if (Object.keys(file).some(key => !['absItemId', 'absIno', 'relativePath', 'role', 'size', 'sha256', 'manifestVersion', 'expectedText', 'limitation'].includes(key))) throw new Error('Invalid fixture file fields');
    const absItemId = identity(file.absItemId); const absIno = identity(file.absIno);
    const key = `${absItemId}:${absIno}`;
    if (seen.has(key)) throw new Error('Ambiguous fixture file identity');
    seen.add(key);
    if (typeof file.relativePath !== 'string' || !file.relativePath || file.relativePath.length > 2000 ||
        file.relativePath.startsWith('/') || /[\\\u0000-\u001f]/.test(file.relativePath) ||
        /^[A-Za-z]:/.test(file.relativePath) || file.relativePath.split('/').some(part => !part || part === '.' || part === '..') ||
        (file.role !== 'ebook' && file.role !== 'audio') || typeof file.size !== 'number' ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid fixture file representation');
    return {
      absItemId, absIno, relativePath: file.relativePath, role: file.role, size: file.size,
      sha256: file.sha256, manifestVersion: identity(file.manifestVersion),
      ...(typeof file.expectedText === 'string' ? { expectedText: file.expectedText.slice(0, 10000) } : {}),
    };
  });
  return {
    schemaVersion: 1, kind, runId: identity(raw.runId), absVersion: '2.30.0',
    serverBindingProofId: identity(bindingId), libraryId: identity(libraryId),
    ...(providerId ? { providerInstanceId: identity(providerId) } : {}), files: normalized,
  };
}

async function fixtureRequest(
  url: URL, ca: Buffer, options: { method?: string; headers?: Record<string, string>; body?: string; prefixBytes?: number } = {}
): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer; interrupted: boolean }> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { ca, method: options.method ?? 'GET', headers: options.headers }, response => {
      const chunks: Buffer[] = [];
      let size = 0; let settled = false;
      const finish = (interrupted: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks, size), interrupted });
      };
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        const accepted = options.prefixBytes ? chunk.subarray(0, Math.max(0, options.prefixBytes - size)) : chunk;
        chunks.push(accepted); size += accepted.length;
        if (size > 16 * 1024 * 1024) { settled = true; response.destroy(); reject(new Error('Fixture response exceeded proof memory bound')); return; }
        if (options.prefixBytes && size >= options.prefixBytes) {
          const interrupted = !response.complete && size < Number(response.headers['content-length']);
          finish(interrupted); response.destroy(); request.destroy();
        }
      });
      response.once('end', () => finish(false));
      response.once('error', error => { if (!settled) reject(error); });
    });
    request.setTimeout(15000, () => request.destroy(new Error('Fixture response deadline')));
    request.once('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export async function streamFixtureDownload(
  url: URL, ca: Buffer, destination: string,
  options: { expectedBytes: number; headers?: Record<string, string>; append?: boolean }
): Promise<{ status: number; headers: IncomingHttpHeaders; receivedBytes: number; savedBytes: number; sha256: string; peakChunkBytes: number }> {
  const root = await fs.realpath(process.cwd());
  const parent = path.relative(root, await fs.realpath(path.dirname(destination)));
  if (parent.startsWith('..') || path.isAbsolute(parent) || url.protocol !== 'https:' || url.username || url.password ||
      !Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 0 || options.expectedBytes > 1024 * 1024 * 1024) {
    throw new Error('Streamed proof request is outside its declared bounds');
  }
  let prefixBytes = 0;
  if (options.append) {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Resume proof requires an owned regular prefix file');
    prefixBytes = stat.size;
  }
  const file = await fs.open(destination, options.append ? 'a' : 'wx', 0o600);
  let receivedBytes = 0; let peakChunkBytes = 0;
  try {
    const response = await new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = https.get(url, { ca, headers: options.headers }, response => {
        clearTimeout(connect);
        void (async () => {
          const status = response.statusCode ?? 0;
          if (![200, 206].includes(status) || Number(response.headers['content-length']) !== options.expectedBytes ||
              (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') ||
              (options.append && (status !== 206 ||
                response.headers['content-range'] !== `bytes ${prefixBytes}-${prefixBytes + options.expectedBytes - 1}/${prefixBytes + options.expectedBytes}`))) {
            throw new Error('Unexpected streamed original representation');
          }
          const meter = new Transform({
            highWaterMark: 65536,
            transform(chunk: Buffer, _encoding, done) {
              receivedBytes += chunk.length; peakChunkBytes = Math.max(peakChunkBytes, chunk.length);
              done(receivedBytes > options.expectedBytes ? new Error('Streamed proof byte bound exceeded') : null, chunk);
            },
            flush(done) { done(receivedBytes === options.expectedBytes ? null : new Error('Streamed original was incomplete')); },
          });
          const output = file.createWriteStream({ autoClose: false, highWaterMark: 65536 });
          try { await pipeline(response, meter, output); } finally { output.destroy(); }
          resolve({ status, headers: response.headers });
        })().catch(error => { response.destroy(); reject(error); });
      });
      const connect = setTimeout(() => req.destroy(new Error('Streamed proof connection deadline')), 10000);
      req.setTimeout(60000, () => req.destroy(new Error('Streamed proof idle deadline')));
      req.once('error', error => { clearTimeout(connect); reject(error); });
    });
    await file.close();
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(destination, { highWaterMark: 65536 })) hash.update(bytes);
    return { ...response, receivedBytes, savedBytes: (await fs.stat(destination)).size, sha256: hash.digest('hex'), peakChunkBytes };
  } finally { await file.close(); }
}

async function verifyDelivery(manifest: NormalizedFixture, origin: string, out: string) {
  if (manifest.libraryId !== process.env.BOOKS_PROOF_LIBRARY_ID ||
      manifest.serverBindingProofId !== process.env.BOOKS_PROOF_SERVER_BINDING) throw new Error('Fixture binding mismatch');
  const plannedSourceBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (plannedSourceBytes > 2 * 1024 * 1024 * 1024) throw new Error('Fixture source set exceeds the explicit 2 GiB proof budget');
  const { startFixtureApp } = await import('./fixtureApp');
  const root = path.join(process.cwd(), '.test-data', 'books', manifest.runId);
  const app = await startFixtureApp(root, origin, manifest.libraryId);
  const ca = await fs.readFile(process.env.BOOKS_PROOF_TLS_CERT_FILE!);
  const url = (pathname: string) => {
    const target = new URL(pathname, app.origin);
    if (target.origin !== app.origin || !pathname.startsWith('/api/')) throw new Error('Fixture request changed origin');
    return target;
  };
  const get = (pathname: string, options: Parameters<typeof fixtureRequest>[2] = {}) => fixtureRequest(url(pathname), ca, options);
  const results = [];
  try {
    const subjects = [];
    for (const user of app.users.slice(0, 3)) {
      const auth = { Authorization: `Bearer ${user.bearer}`, Origin: app.origin };
      const bridge = await get('/api/books/media-session', { method: 'POST', headers: auth });
      if (bridge.status !== 200) throw new Error('Fixture media-session exchange failed');
      const cookie = bridge.headers['set-cookie']?.find(value => value.startsWith('__Secure-lda_books='))?.split(';')[0];
      if (!cookie) throw new Error('Fixture Secure cookie absent');
      subjects.push({ auth, cookie });
    }
    for (const [index, expected] of manifest.files.entries()) {
      const { auth, cookie } = subjects[index % subjects.length];
      const detailResponse = await get(`/api/books/items/${expected.absItemId}`, { headers: auth });
      if (detailResponse.status !== 200) throw new Error('Fixture item unavailable');
      const item = JSON.parse(detailResponse.bytes.toString()) as BookItem;
      const mapping = new Database(path.join(root, 'books-fixture.db'), { readonly: true, fileMustExist: true });
      let fileId: string | undefined;
      try {
        const row = mapping.prepare(`SELECT file_id FROM books_files
          WHERE provider_id = ? AND library_id = ? AND item_id = ? AND ino = ?`)
          .get(item.providerInstanceId, item.libraryId, item.itemId, expected.absIno) as { file_id: string } | undefined;
        fileId = row?.file_id;
      } finally { mapping.close(); }
      const file = item.files.find(file => file.fileId === fileId);
      if (!file || file.role !== expected.role || file.size !== expected.size) throw new Error('Fixture manifest identity mismatch');
      const issue = await get('/api/books/download-tickets', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: [{ itemId: item.itemId, fileId: file.fileId, contentVersion: file.contentVersion }] }),
      });
      const ticket = (JSON.parse(issue.bytes.toString()) as { results: Array<{ ticket?: { url: string } }> }).results[0].ticket;
      if (!ticket || !/^\/api\/books\/downloads\/[A-Za-z0-9_-]+$/.test(ticket.url)) throw new Error('Fixture original ticket unavailable');
      const head = await get(ticket.url, { method: 'HEAD', headers: { Cookie: cookie } });
      const fullPath = path.join(out, `download-${index}-full.bin`);
      const resumedPath = path.join(out, `download-${index}.bin`);
      const full = await streamFixtureDownload(url(ticket.url), ca, fullPath, { expectedBytes: expected.size, headers: { Cookie: cookie } });
      const cut = Math.max(1, Math.min(8192, Math.floor(expected.size / 2)));
      const prefix = await get(ticket.url, { headers: { Cookie: cookie }, prefixBytes: cut });
      const validator = head.headers.etag?.startsWith('W/') ? head.headers['last-modified'] : head.headers.etag ?? head.headers['last-modified'];
      await fs.writeFile(resumedPath, prefix.bytes, { flag: 'wx', mode: 0o600 });
      const resumed = await streamFixtureDownload(url(ticket.url), ca, resumedPath, {
        expectedBytes: expected.size - prefix.bytes.length, append: true,
        headers: { Cookie: cookie, Range: `bytes=${prefix.bytes.length}-`, ...(validator ? { 'If-Range': validator } : {}) },
      });
      const bounded = await get(ticket.url, { headers: { Cookie: cookie, Range: 'bytes=2-5' } });
      const suffix = await get(ticket.url, { headers: { Cookie: cookie, Range: 'bytes=-3' } });
      const invalid = await get(ticket.url, { headers: { Cookie: cookie, Range: `bytes=${expected.size + 1}-` } });
      const mismatch = await get(ticket.url, {
        headers: { Cookie: cookie, Range: 'bytes=2-', 'If-Range': '"not-the-original"' }, prefixBytes: cut,
      });
      const other = await get(ticket.url, { headers: subjects[(index + 1) % subjects.length].auth });
      const saved = await fs.open(fullPath, 'r');
      const first = Buffer.alloc(4); const last = Buffer.alloc(3); const beginning = Buffer.alloc(cut);
      try {
        await saved.read(first, 0, 4, 2); await saved.read(last, 0, 3, expected.size - 3);
        await saved.read(beginning, 0, cut, 0);
      } finally { await saved.close(); }
      const pass = head.status === 200 && head.bytes.length === 0 && Number(head.headers['content-length']) === expected.size &&
        full.status === 200 && full.sha256 === expected.sha256 && full.savedBytes === expected.size &&
        resumed.status === 206 && resumed.sha256 === expected.sha256 && resumed.savedBytes === expected.size &&
        bounded.status === 206 && bounded.bytes.equals(first) &&
        bounded.headers['content-range'] === `bytes 2-5/${expected.size}` && bounded.headers['content-length'] === '4' &&
        suffix.status === 206 && suffix.bytes.equals(last) &&
        invalid.status === 416 && mismatch.status === 200 && mismatch.bytes.equals(beginning) &&
        Number(mismatch.headers['content-length']) === expected.size && other.status === 404;
      results.push({
        itemId: item.itemId, fileId: file.fileId, consumerProviderInstanceId: item.providerInstanceId,
        expectedSha256: expected.sha256, originalSha256: full.sha256, resumedSha256: resumed.sha256,
        size: expected.size, etag: head.headers.etag, lastModified: head.headers['last-modified'],
        interrupted: prefix.interrupted, savedPrefixBytes: prefix.bytes.length,
        head: head.status, bounded: bounded.status, suffix: suffix.status, unsatisfiable: invalid.status,
        ifRangeMismatch: mismatch.status, ifRangeMismatchProof: 'fresh-full-headers-and-saved-prefix',
        peakChunkBytes: Math.max(full.peakChunkBytes, resumed.peakChunkBytes), savedFiles: [`download-${index}-full.bin`, `download-${index}.bin`],
        otherUser: other.status, verdict: pass ? 'pass' : 'fail',
      });
    }
    return {
      schemaVersion: 1, runId: manifest.runId, serverBindingProofId: manifest.serverBindingProofId,
      sourceProviderInstanceId: manifest.providerInstanceId, absVersion: manifest.absVersion,
      runtime: { node: process.version }, files: results,
      plannedSourceBytes, retainedDownloadBytes: plannedSourceBytes * 2,
      streamBufferHighWaterMark: 65536,
      verdict: results.every(result => result.verdict === 'pass') && results.some(result => result.interrupted) ? 'pass' : 'blocked',
      observedAt: new Date().toISOString(),
    };
  } finally { await app.stop(); }
}

interface PrincipalAttestation {
  absVersion: '2.30.0';
  serverBindingProofId: string;
  active: true;
  isAdmin: false;
  accessAllLibraries: false;
  libraryIds: string[];
  permissions: { download: true; update: false; delete: false; upload: false };
}

export function validateProofTarget(origin: string, ownerApproved: boolean): void {
  const url = providerOrigin(origin);
  const isolated = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    /^seekr-[a-f0-9]{8}-[a-z0-9-]+-abs$/.test(url.hostname);
  if (!isolated && !ownerApproved) throw new Error('Non-isolated proof target requires explicit read-only owner approval');
}

function principalAttestation(value: unknown, libraryId: string, binding: string): PrincipalAttestation {
  if (!value || typeof value !== 'object') throw new Error('Restricted principal attestation required');
  const input = value as Partial<PrincipalAttestation>;
  if (input.absVersion !== '2.30.0' || input.serverBindingProofId !== binding ||
      input.active !== true || input.isAdmin !== false || input.accessAllLibraries !== false ||
      !Array.isArray(input.libraryIds) || input.libraryIds.length !== 1 || input.libraryIds[0] !== libraryId ||
      input.permissions?.download !== true || input.permissions.update !== false ||
      input.permissions.delete !== false || input.permissions.upload !== false) {
    throw new Error('Restricted principal attestation does not satisfy the Books permission contract');
  }
  return {
    absVersion: '2.30.0', serverBindingProofId: binding, active: true, isAdmin: false,
    accessAllLibraries: false, libraryIds: [libraryId],
    permissions: { download: true, update: false, delete: false, upload: false },
  };
}

export async function verifyCatalogContract(repository: BooksRepository, attestation: unknown, signal: AbortSignal) {
  const config = repository.readConfig();
  const credential = repository.readCredential();
  if (!config || !credential) throw new Error('Protected fixture configuration required');
  const principal = principalAttestation(attestation, config.libraryId, config.serverBindingProofId);
  const client = new AbsClient(config, credential, repository);
  const library = await client.library(signal);
  const inventory = await client.list(boundedQuery({}), signal);
  const filters: Record<string, { total: number; returned: number }> = {};
  for (const filter of ['ebook', 'single', 'multi']) {
    const page = await client.list(boundedQuery({ filter }), signal);
    filters[filter] = { total: page.total, returned: page.items.length };
  }
  const examples = [];
  for (const summary of inventory.items.slice(0, 10)) examples.push(await client.item(summary.itemId, signal));
  const query = inventory.items[0]?.title;
  const matches = query ? await client.search(config.libraryId, query.slice(0, 200), signal) : [];
  const dualItems = examples.filter(item => item.files.some(f => f.role === 'ebook') && item.tracks.length > 0)
    .map(item => ({ itemId: item.itemId, read: item.read.available, listen: item.listen.available }));
  return {
    schemaVersion: 1,
    kind: 'catalog-contract',
    verdict: inventory.total > 0 && dualItems.length > 0 ? 'pass' : 'blocked',
    blockers: [...(inventory.total === 0 ? ['No indexed fixtures'] : []), ...(dualItems.length === 0 ? ['Dual-format fixture not observed in bounded sample'] : [])],
    runtime: { node: process.version },
    absVersion: principal.absVersion,
    serverBindingProofId: principal.serverBindingProofId,
    providerInstanceId: config.providerInstanceId,
    configGeneration: config.configGeneration,
    principalRights: 'attested-by-isolated-provisioner',
    principal,
    library,
    inventory: { total: inventory.total, page: inventory.page, limit: inventory.limit, returned: inventory.items.length },
    filters, search: { performed: Boolean(query), bookMatches: matches.length },
    dualItems, examples,
    observedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const delivery = args.includes('--delivery');
  const manifestIndex = args.indexOf('--fixture-manifest');
  if (!args.includes('--read-only') || outIndex < 0 || !args[outIndex + 1] ||
      args.length !== (delivery ? 6 : 3) || new Set(args).size !== args.length ||
      (delivery && (manifestIndex < 0 || !args[manifestIndex + 1]))) {
    throw new Error('Usage: verifyAbs --read-only [--delivery --fixture-manifest <file>] --out <execution-root directory>');
  }
  const root = await fs.realpath(process.cwd());
  const out = path.resolve(args[outIndex + 1]);
  const relative = path.relative(root, out);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) throw new Error('Proof output must stay inside the execution root');
  await fs.mkdir(out, { recursive: true });
  const actual = path.relative(root, await fs.realpath(out));
  if (actual.startsWith('..') || path.isAbsolute(actual)) throw new Error('Proof output escapes execution root');
  const origin = process.env.BOOKS_PROOF_ABS_ORIGIN ?? '';
  validateProofTarget(origin, process.env.BOOKS_PROOF_READ_ONLY_OWNER_APPROVED === 'true');
  const credential = process.env.BOOKS_PROOF_ABS_TOKEN ??
    (process.env.BOOKS_PROOF_ABS_TOKEN_FILE ? (await fs.readFile(process.env.BOOKS_PROOF_ABS_TOKEN_FILE, 'utf8')).trim() : '');
  const attestationFile = process.env.BOOKS_PROOF_PRINCIPAL_ATTESTATION;
  if (!credential || !attestationFile) throw new Error('Protected fixture credential and principal attestation required');
  const attestation: unknown = JSON.parse(await fs.readFile(attestationFile, 'utf8'));
  const db = new Database(':memory:');
  try {
    const repo = new BooksRepository(db, randomBytes(32).toString('hex'));
    repo.setConfig({
      enabled: true, providerInstanceId: '', configGeneration: 0, origin,
      libraryId: process.env.BOOKS_PROOF_LIBRARY_ID ?? '',
      serverBindingProofId: process.env.BOOKS_PROOF_SERVER_BINDING ?? '',
    }, credential);
    const report = await verifyCatalogContract(repo, attestation, AbortSignal.timeout(120000));
    const evidence = {
      ...report,
      revision: process.env.BOOKS_PROOF_REVISION ?? 'uncommitted',
      probeSha256: createHash('sha256').update(await fs.readFile(__filename)).digest('hex'),
    };
    await fs.writeFile(path.join(out, 'catalog-contract.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ verdict: report.verdict, count: report.inventory.total, dualItems: report.dualItems.length }));
    if (report.verdict !== 'pass') process.exitCode = 2;
    if (delivery) {
      const manifest = normalizeFixtureManifest(JSON.parse(await fs.readFile(args[manifestIndex + 1], 'utf8')));
      const result = await verifyDelivery(manifest, origin, out);
      await fs.writeFile(path.join(out, 'delivery-contract.json'), JSON.stringify({
        ...result, revision: evidence.revision, probeSha256: evidence.probeSha256,
      }, null, 2));
      console.log(JSON.stringify({ deliveryVerdict: result.verdict, files: result.files.length }));
      if (result.verdict !== 'pass') process.exitCode = 2;
    }
  } finally { db.close(); }
}

if (require.main === module) {
  void main().catch(() => {
    console.error('Books read-only proof failed; verify protected fixture inputs and provider access');
    process.exitCode = 1;
  });
}
