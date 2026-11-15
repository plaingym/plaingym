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

// Reviewed contract steps only: exact journal tag -> { sha256, reason, removedColumns: [{ table, column }] }.
// Keep empty until a named contract step has been reviewed; changed SQL must be reviewed again.
export const contractExceptions = Object.freeze({});

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

// Dollar bodies stay visible to the destructive checks, without interpreting their apostrophes
// as outer SQL strings. This is deliberately conservative even for text inside a function.
function reviewSql(sql, label) {
  let ddl = '', index = 0;
  const identifier = /[\w$\u0080-\uffff]/;
  const unbalanced = kind => { throw new Error(`${label}: unbalanced ${kind}`); };
  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      // PostgreSQL ends a line comment at either newline character.
      const end = sql.slice(index + 2).search(/[\n\r]/);
      index = end < 0 ? sql.length : index + 2 + end;
      ddl += ' ';
    } else if (sql.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) unbalanced('comment');
      ddl += ' ';
    } else {
      const delimiter = sql[index] === '$' && !identifier.test(sql[index - 1] ?? '')
        ? sql.slice(index).match(/^\$(?:[a-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/i)?.[0] : undefined;
      const escapeString = /[eE]/.test(sql[index]) && sql[index + 1] === "'" && !identifier.test(sql[index - 1] ?? '');
      if (delimiter) {
        const start = index + delimiter.length, end = sql.indexOf(delimiter, start);
        if (end < 0) unbalanced('dollar quote');
        ddl += ' ' + sql.slice(start, end) + ' ';
        index = end + delimiter.length;
      } else if (escapeString || sql[index] === "'" || sql[index] === '"') {
        const start = index;
        if (escapeString) index++;
        const quote = sql[index++];
        let closed = false;
        while (index < sql.length) {
          if (escapeString && sql[index] === '\\') { index += 2; }
          else if (sql[index] === quote) {
            index++;
            if (sql[index] === quote) index++;
            else { closed = true; break; }
          } else index++;
        }
        if (!closed) unbalanced(quote === '"' ? 'identifier quote' : 'string quote');
        // A quoted identifier is only a name: keep it readable in errors, but replace non-word
        // characters so spaces or semicolons in a name can't hide or split a statement.
        ddl += quote === '"' ? `"${sql.slice(start + 1, index - 1).replace(/\W/g, '_')}"` : "''";
      } else ddl += sql[index++];
    }
  }
  return ddl;
}

/** Conservative SQL review: ignore comments and ordinary/escape strings, retain dollar bodies
 * and punctuation, and keep quoted identifiers with non-word characters replaced. Unbalanced quotes and comments fail closed.
 * Constraint/index replacement is allowed; removing a stored column, table, type, or schema is not.
 * Exact, reviewed contract steps can be exempted. Unknown destructive DDL fails closed.
 */
export function assertExpandOnly(sql, label, exceptions = contractExceptions) {
  const ddl = reviewSql(sql, label);
  if (Object.hasOwn(exceptions, label)) {
    const exception = exceptions[label];
    assert.ok(exception.reason?.trim(), `${label}: contract exception needs a review reason`);
    assert.equal(exception.sha256, digest(sql), `${label}: reviewed contract SQL changed`);
    assert.ok(Array.isArray(exception.removedColumns ?? []), `${label}: removedColumns must be an array`);
    for (const removed of exception.removedColumns ?? []) {
      assert.ok(typeof removed?.table === 'string' && removed.table.trim() && typeof removed.column === 'string' && removed.column.trim(),
        `${label}: removedColumns needs table and column names`);
    }
    return;
  }
  for (const statement of ddl.split(';')) {
    // DO in an upsert and EXECUTE FUNCTION/PROCEDURE in a trigger are static, additive SQL.
    // Keep every other token for the destructive-DDL checks, including procedural DO and dynamic EXECUTE.
    const procedural = statement.replace(/\bON\s+CONFLICT\b[\s\S]*?\bDO\s+(?:NOTHING|UPDATE)\b/gi,
      clause => clause.replace(/\bDO(?=\s+(?:NOTHING|UPDATE)\b)/gi, '  '))
      .replace(/\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\b/gi, ' ');
    const unsafeDrop = [...statement.matchAll(/\bDROP\s+(?=([\s\S]+))/gi)].some(match => {
      const before = statement.slice(0, match.index), tail = match[1];
      // INDEX and POLICY are also legal bare column names. Only a statement's own
      // DROP command may use them; ALTER TABLE accepts its subcommands alone.
      if (!before.trim()) return !/^(?:INDEX|POLICY)\b/i.test(tail);
      if (!/^\s*ALTER\s+TABLE\b/i.test(statement)) return true;
      if (/^CONSTRAINT\s+(?:IF\s+EXISTS\s+)?["\w.]+/i.test(tail)) return false;
      return !(/\bALTER\s+(?:COLUMN\s+)?["\w.]+\s*$/i.test(before) && /^(?:DEFAULT|NOT\s+NULL)\b/i.test(tail));
    });
    if (/\b(?:TRUNCATE|DELETE\s+FROM|RENAME)\b/i.test(statement)
      || unsafeDrop
      || /\bALTER\s+(?:COLUMN\s+)?["\w.]+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(statement)
      || /\b(?:DO|EXECUTE)\b/i.test(procedural)) {
      throw new Error(`${label}: non-expand migration: ${statement.trim()}`);
    }
  }
}

// Only migrations applied after this gate can exclude columns from its upgrade comparison.
export function contractRemovals(entries, exceptions = contractExceptions) {
  return entries.flatMap(({ tag }) => Object.hasOwn(exceptions, tag)
    ? (exceptions[tag].removedColumns ?? []).map(column => ({ ...column, migration: tag, reason: exceptions[tag].reason })) : []);
}

// One JSON array naming each listed removal whose column still exists (resolved through
// search_path), so a wrong removedColumns entry can't silently hide a retained column.
export function remainingColumnsSql(removedColumns) {
  if (!removedColumns.length) return "SELECT '[]'::json;";
  const rows = removedColumns.map(({ table, column }) => `(${quote(`${table}.${column}`)},${quote(ident(table))},${quote(column)})`);
  return `SELECT coalesce(json_agg(r.name ORDER BY r.name), '[]'::json) FROM (VALUES ${rows.join(',')}) r(name, rel, col) WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(r.rel) AND a.attname = r.col AND a.attnum > 0 AND NOT a.attisdropped);`;
}

export function fingerprintSql(tables, rewrittenColumns = new Set(), removedColumns = []) {
  return tables.map(table => {
    const columns = Object.keys(table.columns).filter(column => (table.name !== 'gyms' || !rewrittenColumns.has(column))
      && !removedColumns.some(removed => removed.table === table.name && removed.column === column)).sort().map(ident);
    // Sorting the projected rows also supports a contract that removes the historical id.
    // A table with no surviving gate columns still has its row count checked.
    return `SELECT json_build_array(${quote(table.name)}, json_build_object('rows', count(*), 'sha256', encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), ''), 'UTF8')), 'hex'))) FROM (SELECT ${columns.join(',') || '1 AS "__upgrade_row"'} FROM ${ident(table.name)}) t;`;
  }).join('\n');
}

export function checkChain(directory = new URL('../../' + migrationPath + '/', import.meta.url), exceptions = contractExceptions) {
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', directory), 'utf8'));
  let timestamp = 0;
  for (const [index, entry] of journal.entries.entries()) {
    assert.equal(entry.idx, index + 1, 'migration order');
    assert.ok(entry.when > timestamp, 'migration timestamps must increase');
    timestamp = entry.when;
    if (index >= gates[0].count) assertExpandOnly(readFileSync(new URL(entry.tag + '.sql', directory), 'utf8'), entry.tag, exceptions);
  }
  return journal.entries.length - gates[0].count;
}
