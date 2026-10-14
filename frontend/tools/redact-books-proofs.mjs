import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cleanText = value => value
  .replace(/(\/api\/books\/(?:downloads|readers)\/)[^\s"'<>]+/gi, '$1[REDACTED]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
  .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
function cleanJson(value, key = '') {
  if (/token|cookie|authorization|credential/i.test(key) && typeof value === 'string') return '[REDACTED]';
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) return value.map(item => cleanJson(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, cleanJson(value, key)]));
  return value;
}

export async function redactProofs(directory) {
  const root = path.resolve(directory);
  const relative = path.relative(repo, root);
  const parts = relative.split(path.sep);
  if (relative.startsWith('..') || path.isAbsolute(relative) ||
      !(parts[0] === 'artifacts' && parts[1] === 'books' ||
        parts[0] === '.test-data' && parts[1] === 'books' && (parts[2] === 'results' || parts[2]?.startsWith('redaction-')))) {
    throw new Error('Proof redaction is restricted to owned Books evidence directories');
  }
  let scanned = 0; let changed = 0;
  async function walk(dir, depth = 0) {
    if (depth > 16) throw new Error('Proof directory nesting exceeds the bound');
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
      if (!entry.isFile() || !/\.(md|json|txt|log)$/i.test(entry.name)) continue;
      const input = await fs.readFile(file, 'utf8');
      let output;
      if (entry.name.endsWith('.json')) {
        try { output = JSON.stringify(cleanJson(JSON.parse(input)), null, 2); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; output = cleanText(input); }
      } else output = cleanText(input);
      scanned += 1;
      if (output !== input) { await fs.writeFile(file, output); changed += 1; }
    }
  }
  await walk(root);
  return { scanned, changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const input of process.argv.slice(2)) console.log(await redactProofs(input));
}
