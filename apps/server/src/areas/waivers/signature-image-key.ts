// SPDX-License-Identifier: AGPL-3.0-only
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const path = new RegExp(`^(${uuid})/waivers/(${uuid})/signatures/(${uuid})\\.png$`);

/** Immutable signature image keys, shared by signing, admission and cleanup. */
export function parseSignatureImageKey(key: string) {
  const match = path.exec(key);
  return match?.[0] === key ? { gymId: match[1]!, memberId: match[2]!, imageId: match[3]! } : undefined;
}
