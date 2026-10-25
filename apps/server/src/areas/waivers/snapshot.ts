// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { AppError } from '@plaingym/shared';
import { waiverSigningSnapshotSchema } from '@plaingym/shared/contracts';
import type { WaiverSigningSnapshot } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';

export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function invalid(message: string): never { throw new AppError('invalid_request', message); }
export function needsGuardian(birth: string | null, now: Date, timezone: string) {
  // An unknown birthday cannot establish adulthood.
  if (!birth) return true;
  const today = localDate(now, timezone);
  const years = Number(today.slice(0, 4)) - Number(birth.slice(0, 4)) - Number(today.slice(5) < birth.slice(5));
  return years < 18;
}
export function serializeSnapshot(value: WaiverSigningSnapshot) {
  const snapshot = JSON.stringify(waiverSigningSnapshotSchema.parse(value));
  return { snapshot, snapshotHash: digest(snapshot) };
}
export function readSnapshot(snapshot: string, hash: string) {
  if (digest(snapshot) !== hash) throw new Error('Waiver snapshot integrity failure');
  return waiverSigningSnapshotSchema.parse(JSON.parse(snapshot));
}
export function validateSignatureImage(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.length < 33 || b.length > 256 * 1024 || !b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || b.toString('ascii', 12, 16) !== 'IHDR' || b.readUInt32BE(16) < 1 || b.readUInt32BE(20) < 1
    || b.readUInt32BE(16) > 1200 || b.readUInt32BE(20) > 600) invalid('Invalid signature PNG');
  // Accept the bounded, non-interlaced RGB/RGBA PNGs produced by canvas. Validate
  // the compressed stream before committing a signature, including a hard inflate cap.
  if (b[24] !== 8 || ![2, 6].includes(b[25]!) || b[26] !== 0 || b[27] !== 0 || b[28] !== 0) invalid('Unsupported signature PNG');
  const compressed: Buffer[] = []; let offset = 8, ended = false;
  while (offset + 12 <= b.length) {
    const length = b.readUInt32BE(offset), end = offset + 12 + length;
    if (end > b.length || crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) invalid('Invalid signature PNG');
    const type = b.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR' && (offset !== 8 || length !== 13)) invalid('Invalid signature PNG');
    if (!/^[A-Za-z]{4}$/.test(type)) invalid('Invalid signature PNG');
    if (!['IHDR', 'IDAT', 'IEND'].includes(type) && !/^[a-z]/.test(type)) invalid('Unsupported signature PNG');
    if (type === 'IDAT') compressed.push(b.subarray(offset + 8, end - 4));
    if (type === 'IEND') { ended = length === 0 && end === b.length; break; }
    offset = end;
  }
  if (!ended || !compressed.length) invalid('Invalid signature PNG');
  const stride = 1 + b.readUInt32BE(16) * (b[25] === 6 ? 4 : 3), expected = stride * b.readUInt32BE(20);
  try {
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (raw.length !== expected) invalid('Invalid signature PNG');
    for (let row = 0; row < raw.length; row += stride) if (raw[row]! > 4) invalid('Invalid signature PNG');
  } catch { invalid('Invalid signature PNG'); }
}
