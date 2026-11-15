// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertExpandOnly, contractExceptions, contractRemovals, fingerprintSql, remainingColumnsSql, digest, gates, history, checkChain } from './history.mjs';

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
  // The old apostrophe stripper swallowed the DROP between the two unrelated apostrophes.
  "CREATE FUNCTION label() RETURNS text AS $$ SELECT $m$it's$m$ $$ LANGUAGE sql; ALTER TABLE members DROP COLUMN first_name; SELECT 'ok';",
  String.raw`SELECT E'it\'s'; ALTER TABLE members DROP COLUMN first_name; SELECT 'ok';`,
  'CREATE FUNCTION clear() RETURNS void AS $body$ DELETE FROM members; $body$ LANGUAGE sql;',
  'CREATE FUNCTION clear() RETURNS void AS $$ ALTER TABLE members DROP COLUMN first_name; $$ LANGUAGE sql;',
  // PostgreSQL ends a line comment at a bare carriage return too.
  '-- note\rALTER TABLE members DROP COLUMN first_name;\n',
  // Quoted names with spaces or semicolons must not hide a type change.
  'ALTER TABLE "members" ALTER COLUMN "first name" SET DATA TYPE integer;',
  'ALTER TABLE "members" ALTER COLUMN "first-name" TYPE integer;',
  'ALTER TABLE "members" ALTER COLUMN "a;" TYPE integer;',
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
  "CREATE FUNCTION label() RETURNS text AS $$ SELECT $m$it's$m$ $$ LANGUAGE sql; ALTER TABLE members ADD COLUMN label text;",
  String.raw`SELECT e'it\'s; DROP TABLE members'; ALTER TABLE members ADD COLUMN label text;`,
  String.raw`SELECT E'backslash\\'; ALTER TABLE members ADD COLUMN label text;`,
  "SELECT 'it''s'; ALTER TABLE members ADD COLUMN label text;",
  '/* outer /* inner */ DROP TABLE members */ ALTER TABLE members ADD COLUMN label text;',
  'ALTER TABLE "member""labels" ADD COLUMN label text;',
]) test(`permits ${sql}`, () => assertExpandOnly(sql, 'expand'));

for (const sql of ["SELECT 'unfinished", String.raw`SELECT E'unfinished\'`, 'SELECT $body$unfinished',
  'SELECT $$unfinished', 'SELECT "unfinished', '/* unfinished', '/* outer /* inner */']) {
  test(`fails closed on ${sql}`, () => {
    assert.throws(() => assertExpandOnly(sql, 'probe'), /unbalanced/);
    assert.throws(() => assertExpandOnly(sql, 'probe', { probe: { sha256: digest(sql), reason: 'Reviewed' } }), /unbalanced/);
  });
}

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
  const reviewed = { [tag]: { sha256: digest(sql), reason: 'Retired column after the compatibility window; reviewed contract step.',
    removedColumns: [{ table: 'members', column: 'retired_label' }] } };
  assert.throws(() => checkChain(url), /non-expand migration/);
  assert.equal(checkChain(url, reviewed), 1);
  assert.throws(() => assertExpandOnly(sql, 'another_migration', reviewed), /non-expand migration/);
  assert.throws(() => assertExpandOnly(sql + '\n', tag, reviewed), /reviewed contract SQL changed/);
  assert.throws(() => assertExpandOnly(sql, tag, { [tag]: { sha256: digest(sql), reason: '' } }), /review reason/);
  assert.throws(() => assertExpandOnly(sql, tag, { [tag]: { ...reviewed[tag], removedColumns: [{}] } }), /table and column names/);
  assert.throws(() => assertExpandOnly(sql, tag, { [tag]: { ...reviewed[tag], removedColumns: [null] } }), /table and column names/);
  assert.throws(() => assertExpandOnly(sql, tag, { [tag]: { ...reviewed[tag], removedColumns: 'members.retired_label' } }), /must be an array/);

  const removals = contractRemovals(entries.slice(gates[0].count), reviewed);
  assert.deepEqual(removals, [{ table: 'members', column: 'retired_label', migration: tag, reason: reviewed[tag].reason }]);
  assert.deepEqual(contractRemovals(entries.slice(3), reviewed), [], 'an already applied contract excludes nothing');
  assert.deepEqual(contractRemovals(entries, {}), [], 'unlisted migrations exclude nothing');
  assert.equal(remainingColumnsSql([]), "SELECT '[]'::json;");
  assert.match(remainingColumnsSql([{ table: "o'members", column: 'retired_label' }]),
    /\(VALUES \('o''members\.retired_label','"o''members"','retired_label'\)\) r\(name, rel, col\)/, 'each removal is checked by exact quoted name');
  const tables = [
    { name: 'members', columns: { id: {}, retired_label: {}, name: {} } },
    { name: 'other_members', columns: { id: {}, retired_label: {} } },
    { name: 'gyms', columns: { id: {}, smtp: {} } },
  ];
  const original = fingerprintSql(tables, new Set(['smtp']));
  const comparable = fingerprintSql(tables, new Set(['smtp']), removals);
  assert.ok(original.includes('FROM (SELECT "id","name","retired_label" FROM "members")'), 'pre-migration checksum includes the removed column');
  assert.ok(comparable.includes('FROM (SELECT "id","name" FROM "members")'), 'both upgrade fingerprints omit the named column');
  assert.ok(comparable.includes('FROM (SELECT "id","retired_label" FROM "other_members")'), 'same column name in another table stays checked');
  assert.ok(comparable.includes('FROM (SELECT "id" FROM "gyms")'), 'secret rewrite exclusion stays separate');
  assert.equal((comparable.match(/'rows', count\(\*\)/g) ?? []).length, tables.length, 'every table retains its row count check');
  assert.match(fingerprintSql([{ name: 'legacy', columns: { id: {} } }], new Set(), [{ table: 'legacy', column: 'id' }]),
    /FROM \(SELECT 1 AS "__upgrade_row" FROM "legacy"\)/, 'count and checksum remain valid with no surviving columns');
});
