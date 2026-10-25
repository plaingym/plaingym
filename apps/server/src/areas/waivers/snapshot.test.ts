// SPDX-License-Identifier: AGPL-3.0-only
import { crc32 } from 'node:zlib';
import { expect, it } from 'vitest';
import { validateSignatureImage } from './snapshot.js';
import { pdfFixture } from './pdf.fixture.js';
import { renderWaiver } from './pdf.js';
import { digest } from './snapshot.js';
function withChunk(type: string) {
  const original = Buffer.from(pdfFixture().png), data = Buffer.from('optional metadata');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, 4, 'ascii'); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]);
}
it.each(['iCCP', 'tEXt', 'eXIf'])('accepts and renders a signature containing ancillary %s', async type => {
  const png = withChunk(type);
  expect(() => validateSignatureImage(png)).not.toThrow();
  const f = pdfFixture(), snapshot = JSON.parse(f.snapshot);
  snapshot.signatureImage.hash = digest(png);
  const raw = JSON.stringify(snapshot);
  expect(await renderWaiver(raw, digest(raw), png)).toBeInstanceOf(Uint8Array);
});
it('still rejects unknown critical chunks and bad ancillary CRCs', () => {
  expect(() => validateSignatureImage(withChunk('ABCD'))).toThrow('Unsupported');
  const corrupted = withChunk('tEXt'); corrupted[42] = corrupted[42]! ^ 1;
  expect(() => validateSignatureImage(corrupted)).toThrow('Invalid');
});
