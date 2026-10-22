// SPDX-License-Identifier: AGPL-3.0-only
/** Streaming ZIP32 with uncompressed CSV entries and data descriptors; memory is one input page. */
export interface ArchiveEntry { name: string; body: AsyncIterable<Uint8Array> }
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i >>> 0;
});
function crcUpdate(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return crc >>> 0;
}
function header(size: number, values: readonly [number, number, 2 | 4][]): Uint8Array {
  const data = new Uint8Array(size), view = new DataView(data.buffer);
  for (const [offset, value, width] of values) {
    if (value < 0 || value > (width === 2 ? 65535 : 0xffffffff)) throw new Error('CSV archive exceeds ZIP32 limits');
    if (width === 2) view.setUint16(offset, value, true); else view.setUint32(offset, value, true);
  }
  return data;
}
export async function* zipEntries(entries: AsyncIterable<ArchiveEntry>): AsyncGenerator<Uint8Array> {
  const central: Uint8Array[] = []; let offset = 0, count = 0;
  for await (const entry of entries) {
    const name = new TextEncoder().encode(entry.name), start = offset;
    const local = header(30, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x808, 2], [12, 33, 2], [26, name.length, 2]]);
    yield local; yield name; offset += local.length + name.length;
    let crc = 0xffffffff, size = 0;
    for await (const bytes of entry.body) { crc = crcUpdate(crc, bytes); size += bytes.length; offset += bytes.length; yield bytes; }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = header(16, [[0, 0x08074b50, 4], [4, crc, 4], [8, size, 4], [12, size, 4]]);
    yield descriptor; offset += descriptor.length;
    central.push(header(46, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x808, 2], [14, 33, 2],
      [16, crc, 4], [20, size, 4], [24, size, 4], [28, name.length, 2], [42, start, 4]]), name);
    count++;
  }
  let size = 0;
  for (const bytes of central) { size += bytes.length; yield bytes; }
  yield header(22, [[0, 0x06054b50, 4], [8, count, 2], [10, count, 2], [12, size, 4], [16, offset, 4]]);
}
export function archiveStream(entries: AsyncIterable<ArchiveEntry>): ReadableStream<Uint8Array> {
  const iterator = zipEntries(entries);
  return new ReadableStream({
    async pull(controller) {
      try { const result = await iterator.next(); if (result.done) controller.close(); else controller.enqueue(result.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
  });
}
