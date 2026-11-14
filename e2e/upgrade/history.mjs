// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const migrationPath = 'packages/db/src/migrations';
// Internal milestones were not tagged. Keep full commits so a shallow checkout fails explicitly.
export const gates = [
  { gate: 'G3', version: '0.1', commit: 'f7e2b17e830497d5083d41dc40f2e4097e6cbf24', count: 2 },
  { gate: 'G4', version: '0.2', commit: 'f197d5a421aab522aad7299ba632b9fee037ba4b', count: 4 },
  { gate: 'G5', version: '0.3', commit: 'd9b4445d525a1efa9e7673afa13c9dff51f40bda', count: 9 },
  { gate: 'G6', version: '0.4', commit: 'e13f8cee4cd33f6b2b36489f7ca48325628f8604', count: 16 },
];
export const digest = value => createHash('sha256').update(value).digest('hex');
export const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export const ident = value => `"${String(value).replaceAll('"', '""')}"`;
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
export const historical = (commit, path) => git(['show', `${commit}:${path}`]);
export const currentJournal = () => JSON.parse(readFileSync(new URL('../../' + migrationPath + '/meta/_journal.json', import.meta.url), 'utf8'));

export function history(gate) {
  const journal = JSON.parse(historical(gate.commit, `${migrationPath}/meta/_journal.json`));
  assert.equal(journal.entries.length, gate.count, `${gate.gate}: migration count`);
  const current = currentJournal();
  const migrations = journal.entries.map((entry, index) => {
    assert.deepEqual(current.entries[index], entry, `${gate.gate}: historical journal changed`);
    const sql = historical(gate.commit, `${migrationPath}/${entry.tag}.sql`);
    assert.equal(sql, readFileSync(new URL(`../../${migrationPath}/${entry.tag}.sql`, import.meta.url), 'utf8'),
      `${entry.tag}: a published migration was edited`);
    return { ...entry, sql, hash: digest(sql) };
  });
  const last = migrations.at(-1).tag.slice(0, 4);
  const schema = JSON.parse(historical(gate.commit, `${migrationPath}/meta/${last}_snapshot.json`));
  return { migrations, tables: Object.values(schema.tables) };
}

/** Conservative SQL review: ignore comments and strings, but retain quoted identifiers and punctuation.
 * Constraint/index replacement is allowed; removing a stored column, table, type, or schema is not.
 * There are no approved contract steps in the recorded chain. Unknown destructive DDL fails closed.
 */
export function assertExpandOnly(sql, label) {
  const ddl = sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith("'") ? "''" : ' ');
  for (const statement of ddl.split(';')) {
    const unsafeDrop = [...statement.matchAll(/\bDROP\s+(?=([\s\S]+))/gi)].some(([, tail]) => !/^(?:CONSTRAINT|INDEX|POLICY|DEFAULT|NOT\s+NULL)\b/i.test(tail));
    if (/\b(?:TRUNCATE|DELETE\s+FROM|RENAME)\b/i.test(statement)
      || unsafeDrop
      || /\bALTER\s+(?:COLUMN\s+)?["\w.]+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(statement)
      || /\b(?:DO|EXECUTE)\b/i.test(statement)) {
      throw new Error(`${label}: non-expand migration: ${statement.trim()}`);
    }
  }
}

export function checkChain(directory = new URL('../../' + migrationPath + '/', import.meta.url)) {
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', directory), 'utf8'));
  let timestamp = 0;
  for (const [index, entry] of journal.entries.entries()) {
    assert.equal(entry.idx, index + 1, 'migration order');
    assert.ok(entry.when > timestamp, 'migration timestamps must increase');
    timestamp = entry.when;
    if (index >= gates[0].count) assertExpandOnly(readFileSync(new URL(entry.tag + '.sql', directory), 'utf8'), entry.tag);
  }
  return journal.entries.length - gates[0].count;
}
