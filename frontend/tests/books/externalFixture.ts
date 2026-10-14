import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import { flag, id, integer, list, record, text } from '../../src/books/types';
import type { BooksApp } from './harness';

export interface ExternalBinding { providerInstanceId: string; libraryId: string; serverBindingProofId: string }
export interface ExternalFileMap { absItemId: string; absIno: string; fileId: string; contentVersion: string; size: number; role: 'ebook' | 'audio' }
export interface ExternalCandidate {
  revision: string; sourceArchiveSha256: string; dirty: boolean; backendFixtureSha256: string; frontendIndexSha256: string;
}
const digest = (value: unknown, length = 64): string => {
  const result = text(value, length);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(result)) throw new Error('Invalid candidate digest');
  return result;
};
async function scopedFile(root: string, value: string | undefined, secret: boolean): Promise<Buffer> {
  if (!value || !path.isAbsolute(value)) throw new Error('Absolute execution-root fixture file required');
  const actual = await fs.realpath(value);
  const relative = path.relative(await fs.realpath(root), actual);
  const stat = await fs.stat(actual);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || stat.size > 1024 * 1024 ||
      (await fs.lstat(value)).isSymbolicLink()) throw new Error('Fixture input escapes its scope or size bound');
  if (secret && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Fixture session file must be owner-only');
  return fs.readFile(actual);
}
function origin(value: string | undefined): string {
  const url = new URL(value ?? '');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || /^lda-[a-f0-9]{8}-[a-z0-9-]+$/.test(url.hostname))) {
    throw new Error('External Books tests require an explicit isolated HTTPS origin');
  }
  return url.origin;
}
async function request(url: URL, ca: Buffer, bearer?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }, response => {
      if (response.statusCode !== 200 || !(response.socket instanceof TLSSocket) || !response.socket.authorized) {
        response.destroy(); reject(new Error('External fixture identity or TLS verification failed')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (data: Buffer) => {
        size += data.length;
        if (size > 1024 * 1024) { response.destroy(); reject(new Error('External fixture metadata exceeds proof bound')); return; }
        chunks.push(data);
      });
      response.once('end', () => resolve(Buffer.concat(chunks, size)));
      response.once('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('External fixture metadata deadline')));
    req.once('error', reject);
  });
}
export async function loadExternalFixture(root: string): Promise<BooksApp> {
  const url = origin(process.env.BOOKS_TEST_URL);
  const ca = await scopedFile(root, process.env.BOOKS_TEST_CA_FILE, false);
  const raw = record(JSON.parse((await scopedFile(root, process.env.BOOKS_TEST_SESSION_FILE, true)).toString('utf8')));
  if (raw.schemaVersion !== 1 || raw.kind !== 'isolated-books-fixture') throw new Error('Unexpected fixture session schema');
  origin(text(raw.origin, 500));
  const bindingValue = record(raw.binding);
  const binding: ExternalBinding = { providerInstanceId: id(bindingValue.providerInstanceId), libraryId: id(bindingValue.libraryId), serverBindingProofId: id(bindingValue.serverBindingProofId) };
  const source = record(raw.candidate);
  const candidate: ExternalCandidate = {
    revision: digest(source.revision, 40), sourceArchiveSha256: digest(source.sourceArchiveSha256), dirty: flag(source.dirty),
    backendFixtureSha256: digest(source.backendFixtureSha256), frontendIndexSha256: digest(source.frontendIndexSha256),
  };
  const users = list(raw.users, 4).map(value => {
    const user = record(value);
    const bearer = text(user.bearer, 512);
    if (bearer.length < 32 || /[\r\n]/.test(bearer) || integer(user.expiresAt) <= Date.now()) throw new Error('Fixture session expired or invalid');
    return { label: id(user.label), bearer, userId: id(user.userId) };
  });
  if (users.map(user => user.label).join(',') !== 'a,b,owner,a-second-device') throw new Error('Fixture users must be explicit synthetic principals');
  await request(new URL('/api/health', url), ca);
  for (const user of users) {
    const envelope = record(JSON.parse((await request(new URL('/api/auth/me', url), ca, user.bearer)).toString('utf8')));
    const actual = record(envelope.user);
    if (actual.id !== user.userId) throw new Error('Fixture principal mismatch');
  }
  const libraries = list(JSON.parse((await request(new URL('/api/books/libraries', url), ca, users[0].bearer)).toString('utf8')), 1);
  const selected = record(libraries[0]);
  const settings = record(JSON.parse((await request(new URL('/api/settings/books', url), ca, users[2].bearer)).toString('utf8')));
  if (selected.libraryId !== binding.libraryId || selected.providerInstanceId !== binding.providerInstanceId ||
      settings.serverBindingProofId !== binding.serverBindingProofId || settings.enabled !== true) throw new Error('External fixture binding mismatch');
  if (createHash('sha256').update(await request(new URL('/index.html', url), ca)).digest('hex') !== candidate.frontendIndexSha256) {
    throw new Error('External candidate assets changed');
  }
  const fileMap: ExternalFileMap[] = list(raw.fileMap).map(value => {
    const file = record(value);
    if (file.role !== 'ebook' && file.role !== 'audio') throw new Error('Unexpected fixture file role');
    return { absItemId: id(file.absItemId), absIno: id(file.absIno), fileId: id(file.fileId),
      contentVersion: id(file.contentVersion), size: integer(file.size), role: file.role };
  });
  const blocked = (): never => { throw new Error('External fixture mutation and lifecycle are owned separately'); };
  return {
    origin: url, instanceId: id(raw.instanceId), users, binding, candidate, fileMap, live: true,
    certificatePin: createHash('sha256').update(new X509Certificate(ca).publicKey.export({ format: 'der', type: 'spki' })).digest('base64'),
    setUnavailable: blocked, setPdf: blocked, advanceReaderTime: blocked,
    setAudio: async () => blocked(), replaceEpub: async () => blocked(), setCbz: async () => blocked(), restart: async () => blocked(),
    readerCache: async () => blocked(), stop: async () => blocked(),
  };
}
