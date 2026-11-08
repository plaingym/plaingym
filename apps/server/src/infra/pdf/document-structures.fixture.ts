// SPDX-License-Identifier: AGPL-3.0-only
import { deflateSync } from 'node:zlib';

// Authored minimal documents reproducing Word's two-table hybrid layout and
// the forward /Prev layout of linearized files. No third-party document content.
const catalog = '<< /Type /Catalog /Pages 2 0 R >>';
const pages = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F 5 0 R >> >> >>';
const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
const content = 'BT /F 12 Tf 40 700 Td (Original structured waiver) Tj ET';
const stream = (body: Buffer, dict = '') => Buffer.concat([Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`), body, Buffer.from('\nendstream')]);
const pad = (n: number) => String(n).padStart(10, '0');
function writer() {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')], offsets = new Map<number, number>();
  let length = parts[0]!.length;
  const push = (part: string | Buffer) => { const data = Buffer.from(part); parts.push(data); length += data.length; };
  const object = (id: number, body: string | Buffer) => { offsets.set(id, length); push(`${id} 0 obj\n`); push(body); push('\nendobj\n'); };
  return { push, object, offsets, at: () => length, bytes: () => Buffer.concat(parts) };
}
function xrefRows(rows: readonly (readonly [number, number, number])[]) {
  const bytes = Buffer.alloc(rows.length * 7);
  rows.forEach(([type, offset, generation], i) => { bytes[i * 7] = type; bytes.writeUInt32BE(offset, i * 7 + 1); bytes.writeUInt16BE(generation, i * 7 + 5); });
  return bytes;
}
export function hybridPdf() {
  const w = writer();
  [catalog, pages, page, stream(Buffer.from(content)), font].forEach((body, i) => w.object(i + 1, body));
  w.object(6, stream(deflateSync(Buffer.from('7 0 << /Example true >>')), '/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode'));
  const supplemental = w.at();
  w.object(8, stream(deflateSync(xrefRows([[2, 6, 0], [1, supplemental, 0]])), '/Type /XRef /Size 9 /Index [7 2] /W [1 4 2] /Filter /FlateDecode'));
  const base = w.at();
  w.push('xref\n0 9\n0000000000 65535 f \n');
  for (let id = 1; id <= 8; id++) w.push(w.offsets.has(id) ? `${pad(w.offsets.get(id)!)} 00000 n \n` : '0000000000 00000 f \n');
  w.push(`trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${base}\n%%EOF\n`);
  const last = w.at();
  w.push(`xref\n0 0\ntrailer\n<< /Size 9 /Root 1 0 R /Prev ${base} /XRefStm ${supplemental} >>\nstartxref\n${last}\n%%EOF\n`);
  return w.bytes();
}
export function predictedXrefPdf(filter = 2) {
  const w = writer();
  [catalog, pages, page, stream(Buffer.from(content)), font].forEach((body, i) => w.object(i + 1, body));
  const at = w.at();
  const rows = xrefRows([[0, 0, 65535], ...[1, 2, 3, 4, 5].map(id => [1, w.offsets.get(id)!, 0] as const), [1, at, 0]]);
  const predicted = Buffer.alloc(8 * 7);
  for (let row = 0; row < 7; row++) {
    predicted[row * 8] = filter;
    for (let col = 0; col < 7; col++) {
      const index = row * 7 + col, left = col ? rows[index - 1]! : 0, up = row ? rows[index - 7]! : 0, corner = row && col ? rows[index - 8]! : 0;
      const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const value = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : corner;
      predicted[row * 8 + col + 1] = (rows[index]! - value) & 255;
    }
  }
  w.object(6, stream(deflateSync(predicted), '/Type /XRef /Size 7 /Root 1 0 R /W [1 4 2] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >>'));
  w.push(`startxref\n${at}\n%%EOF\n`);
  return w.bytes();
}
export function linearizedPdf() {
  const w = writer();
  w.object(1, '<< /Linearized 1 /L LLLLLLLLLL /H [HHHHHHHHHH HHHHHHHHHL] /O 4 /E EEEEEEEEEE /N 1 /T TTTTTTTTTT >>');
  const firstXref = w.at();
  w.push('xref\n1 7\n');
  for (let id = 1; id <= 7; id++) w.push(`XXXXXXXXX${id} 00000 n \n`);
  w.push('trailer\n<< /Size 8 /Root 2 0 R /Prev PPPPPPPPPP >>\nstartxref\n0\n%%EOF\n');
  w.object(2, '<< /Type /Catalog /Pages 3 0 R >>');
  w.object(3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>');
  w.object(4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F 6 0 R >> >> >>');
  w.object(5, stream(Buffer.from(content))); w.object(6, font);
  const hints = w.at(); w.object(7, stream(Buffer.alloc(36), '/S 36'));
  const main = w.at();
  w.push('xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\n');
  w.push(`startxref\n${firstXref}\n%%EOF\n`);
  let text = w.bytes().toString('latin1');
  for (const [id, at] of w.offsets) text = text.replace(`XXXXXXXXX${id}`, pad(at));
  for (const [key, value] of Object.entries({ LLLLLLLLLL: w.at(), HHHHHHHHHH: hints, HHHHHHHHHL: main - hints, EEEEEEEEEE: main, TTTTTTTTTT: main + 8, PPPPPPPPPP: main })) text = text.replace(key, pad(value));
  return Buffer.from(text, 'latin1');
}
