import { build } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  configFile: false, root, logLevel: 'warn',
  build: { write: false, minify: 'esbuild', target: 'es2020',
    lib: { entry: path.join(root, 'src', 'books', 'reader', 'shell.ts'), name: 'BooksReaderShell', formats: ['iife'] } },
});
const outputs = Array.isArray(result) ? result : [result];
if (outputs.length !== 1 || !('output' in outputs[0])) throw new Error('Unexpected reader build output');
const chunks = outputs[0].output.filter(output => output.type === 'chunk');
if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) throw new Error('Reader must be self-contained');
const script = chunks[0].code.replace(/<\/script/gi, '<\\/script');
const hash = createHash('sha256').update(script).digest('base64');
const csp = `default-src 'none'; connect-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src blob:; font-src blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EPUB reader</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#faf8f1;color:#222;font:16px system-ui}body{display:flex;flex-direction:column}nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #bbb;background:#f1eee5}button,select{font:inherit;color:#222;background:#fff;border:1px solid #777;border-radius:5px;min-height:44px;padding:6px}button:focus-visible,select:focus-visible{outline:3px solid #8d5900}label{display:flex;gap:6px;align-items:center}#contents{max-width:min(18rem,70vw)}#viewport{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}#reader-status{margin:0;padding:4px 12px;font-size:12px}#book{font-size:18px}button:disabled{opacity:.45}
</style></head><body><nav aria-label="Reader controls"><button id="previous" disabled>Previous section</button><label>Contents<select id="contents"></select></label><button id="next" disabled>Next section</button><label>Font size<select id="font"><option value="16">16</option><option value="18" selected>18</option><option value="20">20</option><option value="24">24</option><option value="28">28</option></select></label></nav><p id="reader-status" role="status">Preparing reader...</p><div id="viewport" tabindex="0" aria-label="Book section"><div id="book"></div></div><script>${script}</script></body></html>`;
await fs.mkdir(path.join(root, '.reader-build'), { recursive: true });
await fs.writeFile(path.join(root, '.reader-build', 'shell.html'), html);
const notices = ['Books reader dependency notices. Libraries are bundled without source modifications.\n'];
for (const name of ['foliate-js', 'dompurify', 'css-tree', 'mdn-data', 'source-map-js']) {
  const directory = path.join(root, 'node_modules', name);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  notices.push(`\n${name} ${metadata.version ?? ''} (${metadata.license ?? 'see license'})\n`);
  const licenses = (await fs.readdir(directory)).filter(name => /^(LICENSE|NOTICE|COPYING)([.-].*)?$/i.test(name));
  if (!licenses.length) throw new Error(`Reader dependency license missing: ${name}`);
  for (const file of licenses) notices.push(`${file}\n${await fs.readFile(path.join(directory, file), 'utf8')}`);
}
await fs.writeFile(path.join(root, '.reader-build', 'notices.txt'), notices.join('\n'));
