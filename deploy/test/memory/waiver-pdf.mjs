// SPDX-License-Identifier: AGPL-3.0-only
/** A deterministic static PDF. Most bytes are an uncompressed image used by every
 * page, so copying the pages must retain the data instead of dropping padding. */
export function waiverPdf({ pages = 20, bytes = 10 * 1024 ** 2, imageSide = 1868 } = {}) {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 20 || !Number.isSafeInteger(bytes)
    || bytes > 10 * 1024 ** 2 || !Number.isSafeInteger(imageSide) || imageSide < 1 || imageSide > 1868) throw new Error('Invalid PDF fixture bounds');
  const image = Buffer.alloc(imageSide * imageSide * 3, 127);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${imageSide} /Height ${imageSide} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
  ];
  for (let i = 0; i < pages; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    const content = `q 120 0 0 120 40 560 cm /Im1 Do Q\nBT /F1 14 Tf 40 740 Td (Original waiver page ${i + 1}) Tj ET\n`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  const parts = [Buffer.from('%PDF-1.7\n')], offsets = [0];
  let length = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    parts.push(part); length += part.length;
  }
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n`;
  // Whitespace after the trailer makes the file exactly the upload cap without
  // changing any object/xref offset. The image still accounts for >99% of it.
  const tail = Buffer.from(`${xref}${length}\n%%EOF\n`);
  const padding = bytes - length - tail.length;
  if (padding < 0) throw new Error('PDF fixture does not fit');
  return Buffer.concat([...parts, tail, Buffer.alloc(padding, 32)]);
}
