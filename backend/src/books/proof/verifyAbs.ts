import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { AbsClient } from '../absClient';
import { BooksRepository } from '../repository';
import { boundedQuery, providerOrigin } from '../limits';

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
  if (!args.includes('--read-only') || outIndex < 0 || !args[outIndex + 1] ||
      args.length !== 3 || new Set(args).size !== 3) {
    throw new Error('Usage: verifyAbs --read-only --out <execution-root directory>');
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
  } finally { db.close(); }
}

if (require.main === module) {
  void main().catch(() => {
    console.error('Books read-only proof failed; verify protected fixture inputs and provider access');
    process.exitCode = 1;
  });
}
