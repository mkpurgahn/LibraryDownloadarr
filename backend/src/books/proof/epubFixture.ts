import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader, TextReader } from '@zip.js/zip.js';

const container = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
export const fixturePackage = '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture-book</dc:identifier><dc:title>Fixture book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="first" href="first.xhtml" media-type="application/xhtml+xml"/><item id="second" href="second.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="book.css" media-type="text/css"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>';
export const fixtureChapter = (title: string, paragraphs = 1) =>
  `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title><link rel="stylesheet" href="book.css"/></head><body><h1>${title}</h1>${Array.from({ length: paragraphs }, (_, index) => `<p>Generated and owned reader fixture, paragraph ${index + 1}. A quiet reader follows a journey through an imaginary library, finding one more page to explore.</p>`).join('')}<a href="second.xhtml#next">Next section</a></body></html>`;
const nav = '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="first.xhtml">First section</a></li><li><a href="second.xhtml">Second section</a></li></ol></nav></body></html>';

export async function buildEpubFixture(options: {
  package?: string; first?: string; long?: boolean;
  extra?: Array<{ name: string; data: Uint8Array; password?: string }>;
} = {}): Promise<Buffer> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false, level: 0 });
  for (const [name, data] of [
    ['mimetype', 'application/epub+zip'], ['META-INF/container.xml', container], ['OPS/package.opf', options.package ?? fixturePackage],
    ['OPS/first.xhtml', options.first ?? fixtureChapter('First section', options.long ? 100 : 1)],
    ['OPS/second.xhtml', fixtureChapter('Second section', options.long ? 100 : 1)],
    ['OPS/nav.xhtml', nav], ['OPS/book.css', 'p { color: #222; }'],
  ]) await zip.add(name, new TextReader(data));
  for (const entry of options.extra ?? []) await zip.add(entry.name, new Uint8ArrayReader(entry.data), { password: entry.password });
  return Buffer.from(await zip.close());
}
