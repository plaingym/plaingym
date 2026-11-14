// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertExpandOnly, gates, history, checkChain } from './history.mjs';

test('all gate migrations are unchanged prefixes of the current journal', () => {
  for (const gate of gates) assert.equal(history(gate).migrations.length, gate.count);
  assert.ok(checkChain() > 0);
});
for (const sql of [
  'ALTER TABLE "members" DROP COLUMN "first_name";',
  'ALTER TABLE public.members DROP first_name;',
  'ALTER TABLE members DROP CONSTRAINT old_check, DROP COLUMN first_name;',
  'ALTER TABLE members DROP CONSTRAINT old_check, DROP first_name;',
  'ALTER TABLE members RENAME COLUMN first_name TO name;',
  'ALTER TABLE members RENAME TO people;',
  'DROP TABLE members CASCADE;',
  'ALTER TABLE members ALTER COLUMN first_name TYPE integer USING 1;',
  'TRUNCATE members;', 'DELETE FROM members;',
  "SELECT '--'; ALTER TABLE members DROP first_name;",
  "DO $$ BEGIN EXECUTE 'DROP TABLE members'; END $$;",
]) test(`rejects ${sql}`, () => assert.throws(() => assertExpandOnly(sql, 'probe'), /non-expand migration/));
test('permits additive DDL, backfills, and constraint replacement', () => {
  assertExpandOnly(`-- DROP COLUMN is not executed here
    ALTER TABLE members ADD COLUMN label text;
    UPDATE members SET label = 'DROP TABLE members';
    ALTER TABLE members DROP CONSTRAINT previous_check;
    CREATE INDEX member_labels ON members(label);`, 'expand');
});
