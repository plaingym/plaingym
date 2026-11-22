// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from './id.js';
import { encryptedFieldFor, encryptedFields } from './encrypted-fields.js';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from './schema/index.js';
const uuidv7Format = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it('generates distinct UUIDv7 IDs in order within the same millisecond', () => {
  const timestamp = 1770000000000;
  const ids = Array.from({ length: 1000 }, () => uuidv7(timestamp));
  expect(ids).toEqual([...ids].sort());
  expect(new Set(ids).size).toBe(1000);
  for (const id of ids) {
    expect(id).toMatch(uuidv7Format);
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(timestamp);
  }
});
it('encodes the requested timestamp when the clock moves forwards and backwards', () => {
  const timestamp = 1770000000000;
  for (const now of [timestamp, timestamp + 1, timestamp]) {
    const id = uuidv7(now);
    expect(id).toMatch(uuidv7Format);
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(now);
  }
});
it('keeps a timestamp in order when another timestamp comes in between', () => {
  for (let i = 0; i < 1000; i++) {
    const timestamp = 1780000000000 + i * 10;
    const first = uuidv7(timestamp);
    uuidv7(timestamp - 5);
    const second = uuidv7(timestamp);
    expect(second > first).toBe(true);
  }
});
it('keeps order for the least recently used of eight retained timestamps', () => {
  for (let i = 0; i < 100; i++) {
    const timestamps = Array.from({ length: 8 }, (_, index) => 1790000000000 + i * 100 + index);
    const firsts = timestamps.map((timestamp) => uuidv7(timestamp));
    const revisit = uuidv7(timestamps[0]!);
    expect(revisit > firsts[0]!).toBe(true);
    expect(parseInt(revisit.replaceAll('-', '').slice(0, 12), 16)).toBe(timestamps[0]);
  }
});
it('rejects timestamps outside the UUIDv7 range and non-integers', () => {
  for (const invalid of [-1, NaN, 1.1, 0x1000000000000]) expect(() => uuidv7(invalid)).toThrow();
});
it('registers encrypted fields and fails closed for unknown secret classes', () => {
  const tables = Object.values(schema);
  for (const field of encryptedFields) {
    const table = tables.find((table) => getTableName(table) === field.table)!;
    expect(Object.values(getTableColumns(table)).some((column) => column.name === field.column)).toBe(true);
  }
  for (const table of tables) for (const column of Object.values(getTableColumns(table))) {
    if (column.name.endsWith('_encrypted')) expect(encryptedFields.some((field) => field.table === getTableName(table) && field.column === column.name)).toBe(true);
  }
  expect(() => encryptedFieldFor('unknown')).toThrow('Unregistered');
});
