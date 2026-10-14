export type PdfFixtureMode = 'normal' | 'many-pages' | 'corrupt' | 'password' | 'oversized' | 'replacement';
export function buildPdfFixture(pages = 5, activeContent = true, password = false, title = 'Generated PDF page'): Buffer {
  const objects: string[] = [];
  const font = 3 + pages * 2;
  const action = font + 1;
  const annotation = font + 2;
  const form = font + 3;
  const widget = font + 4;
  objects.push(`<< /Type /Catalog /Pages 2 0 R ${activeContent ? `/OpenAction ${action} 0 R /AcroForm ${form} 0 R` : ''} >>`);
  objects.push(`<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, index) => `${3 + index * 2} 0 R`).join(' ')}] >>`);
  for (let page = 0; page < pages; page++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + page * 2} 0 R ${activeContent ? `/Annots [${annotation} 0 R ${widget} 0 R]` : ''} >>`);
    const content = `BT /F1 24 Tf 54 720 Td (${title} ${page + 1}) Tj /F1 14 Tf 0 -42 Td (Owned fixture for native reading and private resume.) Tj ET\n`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  if (activeContent) {
    objects.push('<< /S /JavaScript /JS (window.pdfScriptExecuted = true;) >>');
    objects.push('<< /Type /Annot /Subtype /Link /Rect [54 650 420 690] /A << /S /URI /URI (https://fixture.invalid/not-contacted) >> >>');
    objects.push(`<< /Fields [${widget} 0 R] >>`);
    objects.push('<< /Type /Annot /Subtype /Widget /FT /Tx /T (FixtureField) /V (Inert field) /Rect [54 580 420 630] /A << /S /SubmitForm /F (https://fixture.invalid/not-submitted) >> >>');
  }
  const encryption = password ? objects.push('<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>') : undefined;
  let output = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R ${encryption ? `/Encrypt ${encryption} 0 R /ID [<00000000000000000000000000000000><00000000000000000000000000000000>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
