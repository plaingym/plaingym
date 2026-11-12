// SPDX-License-Identifier: AGPL-3.0-only
import { sql, type SQLWrapper } from 'drizzle-orm';

// ECMAScript TrimString whitespace, shared by the stored normalization and its lookups.
const whitespace = [0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const trimCharacters = String.fromCharCode(...whitespace);
const trimSql = sql.raw("U&'" + whitespace.map(value => '\\' + value.toString(16).padStart(4, '0')).join('') + "'");

export function normalizeAddress(address: string): string {
  let start = 0, end = address.length;
  while (start < end && trimCharacters.includes(address[start]!)) start++;
  while (end > start && trimCharacters.includes(address[end - 1]!)) end--;
  return address.slice(start, end).toLowerCase();
}

/** Compute the stored address, including legacy whitespace, without changing the source email. */
export const normalizedMemberAddress = (email: SQLWrapper) => sql`lower(btrim(${email}, ${trimSql}))`;
