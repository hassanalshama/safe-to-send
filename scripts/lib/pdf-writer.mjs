// @ts-check

import { deflateSync } from 'node:zlib';

/** @param {string} value */
function literal(value) {
  return `(${value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`;
}

/**
 * @param {{unsafe?: boolean}} [options]
 */
export function createPdf(options = {}) {
  const unsafe = Boolean(options.unsafe);
  const content = unsafe
    ? [
        'q',
        'BT /F1 20 Tf 72 720 Td (Quarterly report) Tj ET',
        'BT /F1 12 Tf 72 650 Td (Card 4111111111111111) Tj ET',
        '0 g 68 645 250 20 re f',
        'BT /F1 12 Tf 3 Tr 72 600 Td (api_key=demo_secret_123456789) Tj ET',
        'BT /F1 12 Tf 1 g 72 560 Td (private.person@example.com) Tj ET',
        'Q',
      ].join('\n')
    : 'BT /F1 20 Tf 72 720 Td (Reviewed distribution copy) Tj ET';
  const compressed = deflateSync(Buffer.from(content, 'latin1'));

  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const annotation = unsafe ? ' /Annots [7 0 R]' : '';
  objects.set(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R${annotation} >>`);
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(5, { dictionary: `<< /Length ${compressed.length} /Filter /FlateDecode >>`, stream: compressed });
  if (unsafe) {
    objects.set(6, `<< /Author ${literal('Internal Strategy Team')} /Creator ${literal('Example Deck Builder')} >>`);
    objects.set(7, `<< /Type /Annot /Subtype /Text /Rect [72 500 90 518] /Contents ${literal('Remove before external circulation')} >>`);
  }

  const header = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary');
  const parts = [header];
  const offsets = [0];
  let position = header.length;
  const maxObject = Math.max(...objects.keys());
  for (let number = 1; number <= maxObject; number += 1) {
    const value = objects.get(number);
    if (!value) continue;
    offsets[number] = position;
    const prefix = Buffer.from(`${number} 0 obj\n`, 'ascii');
    const body = typeof value === 'string'
      ? Buffer.from(`${value}\nendobj\n`, 'latin1')
      : Buffer.concat([
          Buffer.from(`${value.dictionary}\nstream\n`, 'latin1'),
          value.stream,
          Buffer.from('\nendstream\nendobj\n', 'latin1'),
        ]);
    parts.push(prefix, body);
    position += prefix.length + body.length;
  }
  const xrefOffset = position;
  const xref = [`xref\n0 ${maxObject + 1}\n`, '0000000000 65535 f \n'];
  for (let number = 1; number <= maxObject; number += 1) {
    xref.push(`${String(offsets[number] || 0).padStart(10, '0')} 00000 ${offsets[number] ? 'n' : 'f'} \n`);
  }
  const trailer = `trailer\n<< /Size ${maxObject + 1} /Root 1 0 R${unsafe ? ' /Info 6 0 R' : ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(Buffer.from(xref.join(''), 'ascii'), Buffer.from(trailer, 'ascii'));
  if (unsafe) parts.push(Buffer.from('% retained incremental marker\n%%EOF\n', 'ascii'));
  return Buffer.concat(parts);
}
