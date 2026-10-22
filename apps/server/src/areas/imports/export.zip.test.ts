// SPDX-License-Identifier: AGPL-3.0-only
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveStream, type ArchiveEntry } from './export.zip.js';
/** Read the ZIP central directory, verifying CRCs independently with Node's ZIP CRC implementation. */
export function readArchive(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = new Map<string, string>();
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  let position = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(position, true)).toBe(0x02014b50);
    const crc = view.getUint32(position + 16, true), size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true), local = view.getUint32(position + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true), body = bytes.subarray(start, start + size);
    expect(crc32(body)).toBe(crc);
    expect(view.getUint32(start + size, true)).toBe(0x08074b50);
    result.set(name, new TextDecoder().decode(body));
    position += 46 + nameLength;
  }
  expect(position).toBe(end);
  return result;
}
describe('streaming CSV archive', () => {
  it('writes empty and Unicode files across arbitrary chunk boundaries with valid CRCs and offsets', async () => {
    async function* entries(): AsyncGenerator<ArchiveEntry> {
      yield { name: 'members.csv', body: (async function* () { yield new TextEncoder().encode('name\r\n'); yield new TextEncoder().encode('Zoë\r\n'); })() };
      yield { name: 'empty.csv', body: (async function* () {})() };
    }
    const bytes = new Uint8Array(await new Response(archiveStream(entries())).arrayBuffer());
    expect(readArchive(bytes)).toEqual(new Map([['members.csv', 'name\r\nZoë\r\n'], ['empty.csv', '']]));
  });
  it('propagates generator failure instead of publishing a partial archive', async () => {
    async function* entries(): AsyncGenerator<ArchiveEntry> { yield { name: 'bad.csv', body: (async function* () { yield new Uint8Array([1]); throw new Error('read failed'); })() }; }
    await expect(new Response(archiveStream(entries())).arrayBuffer()).rejects.toThrow('read failed');
  });
});
