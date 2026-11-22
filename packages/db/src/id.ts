// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';

/** How many recently used milliseconds keep their counter in this process. */
const retainedTimestamps = 8;
/** Last counter per millisecond, least recently used first (a Map keeps insertion order). */
const counters = new Map<number, bigint>();

/** UUIDv7 with a 48-bit millisecond timestamp and a randomly seeded counter with random increments. */
export function uuidv7(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError('UUIDv7 timestamp is outside the 48-bit range');
  }
  const previous = counters.get(now);
  let value: bigint;
  if (previous === undefined) {
    const random = randomBytes(10);
    // Keep 73 random bits, leaving the highest counter bit clear for increments.
    value = (BigInt(random.readUInt16BE(0) & 0x01ff) << 64n) | random.readBigUInt64BE(2);
  } else {
    value = previous + 1n + BigInt(randomBytes(6).readUIntBE(0, 6));
    if (value >= 2n ** 74n) throw new RangeError('UUIDv7 counter overflow');
  }
  // Re-insert so this millisecond becomes the most recently used, then evict the least recently used.
  counters.delete(now);
  counters.set(now, value);
  if (counters.size > retainedTimestamps) counters.delete(counters.keys().next().value!);

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes.writeUInt16BE(0x7000 | Number(value >> 62n), 6);
  bytes.writeBigUInt64BE((2n << 62n) | (value & ((1n << 62n) - 1n)), 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
