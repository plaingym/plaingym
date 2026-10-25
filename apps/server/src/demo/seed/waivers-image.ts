// SPDX-License-Identifier: AGPL-3.0-only
import { crc32, deflateSync } from 'node:zlib';
/** A synthetic scribble, never an actual person's signature. */
export function demoSignaturePng() {
  const width = 240, height = 80;
  function chunk(name: string, data: Buffer) {
    const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, crc]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 15; x < width - 15; x++) {
      if (Math.abs(y - (40 + 20 * Math.sin(x / 12))) < 2) raw.fill(20, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3);
    }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
