// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from './id.js';
import { encryptedFieldFor, encryptedFields } from './encrypted-fields.js';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from './schema/index.js';
it('encodes the UUIDv7 timestamp, version and random variant', () => {
  const timestamp = 1770000000000;
  const ids = Array.from({ length: 1000 }, () => uuidv7(timestamp));
  expect(new Set(ids).size).toBe(1000);
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(timestamp);
  }
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
