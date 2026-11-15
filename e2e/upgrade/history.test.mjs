// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertExpandOnly, contractExceptions, digest, gates, history, checkChain } from './history.mjs';

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
  'DO $$ BEGIN PERFORM 1; END $$;',
  "EXECUTE 'DROP TABLE members';",
  'INSERT INTO members(id) VALUES (1) ON CONFLICT DO NOTHING; DO $$ BEGIN PERFORM 1; END $$;',
  'CREATE TRIGGER label AFTER INSERT ON members EXECUTE FUNCTION label_member(); DROP TABLE members;',
]) test(`rejects ${sql}`, () => assert.throws(() => assertExpandOnly(sql, 'probe'), /non-expand migration/));
test('permits additive DDL, backfills, and constraint replacement', () => {
  assertExpandOnly(`-- DROP COLUMN is not executed here
    ALTER TABLE members ADD COLUMN label text;
    UPDATE members SET label = 'DROP TABLE members';
    ALTER TABLE members DROP CONSTRAINT previous_check;
    CREATE INDEX member_labels ON members(label);`, 'expand');
});
for (const sql of [
  'INSERT INTO members(id) VALUES (1) ON CONFLICT DO NOTHING;',
  'INSERT INTO members(id, label) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET label = excluded.label;',
  'INSERT INTO members(id) VALUES (1) ON CONFLICT ON CONSTRAINT member_id DO NOTHING;',
  'CREATE TRIGGER label AFTER INSERT ON members FOR EACH ROW EXECUTE FUNCTION label_member();',
  'CREATE TRIGGER label AFTER INSERT ON members FOR EACH ROW EXECUTE PROCEDURE label_member();',
]) test(`permits ${sql}`, () => assertExpandOnly(sql, 'expand'));

test('contract exceptions are empty for the published chain', () => assert.deepEqual(contractExceptions, {}));
test('only an exact, named, reviewed contract migration is exempted by the chain checker', t => {
  const directory = mkdtempSync(join(tmpdir(), 'upgrade-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'meta'));
  const tag = '9999_reviewed_contract', sql = 'ALTER TABLE members DROP COLUMN retired_label;';
  const entries = Array.from({ length: 3 }, (_, index) => ({ idx: index + 1, when: index + 1, tag: index === 2 ? tag : `base_${index}` }));
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ entries }));
  writeFileSync(join(directory, tag + '.sql'), sql);
  const url = pathToFileURL(directory + '/');
  const reviewed = { [tag]: { sha256: digest(sql), reason: 'Retired column after the compatibility window; reviewed contract step.' } };
  assert.throws(() => checkChain(url), /non-expand migration/);
  assert.equal(checkChain(url, reviewed), 1);
  assert.throws(() => assertExpandOnly(sql, 'another_migration', reviewed), /non-expand migration/);
  assert.throws(() => assertExpandOnly(sql + '\n', tag, reviewed), /reviewed contract SQL changed/);
  assert.throws(() => assertExpandOnly(sql, tag, { [tag]: { sha256: digest(sql), reason: '' } }), /review reason/);
});
