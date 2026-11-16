// SPDX-License-Identifier: AGPL-3.0-only
import { pathToFileURL } from 'node:url';
import { git } from './version.mjs';

const migrations = 'packages/db/src/migrations';

/** Tokenize declarative migration SQL, keeping literals opaque and statement boundaries intact.
 * @param {string} source
 */
function statements(source) {
  const result = [];
  // `trailing` is set after a `;` until the next line, so a comment after a statement can't review the next one.
  let tokens = [], line = 1, start = 1, reviewed = '', index = 0, trailing = false;
  const finish = () => {
    if (tokens.length) result.push({ tokens, line: start, reviewed });
    tokens = []; reviewed = ''; trailing = true;
  };
  while (index < source.length) {
    const rest = source.slice(index);
    let raw;
    if (/^\s/.test(rest)) raw = /^\s+/.exec(rest)[0];
    else if (rest.startsWith('--')) {
      raw = /^--[^\n]*/.exec(rest)[0];
      // A review applies only to the immediately following statement.
      if (!tokens.length && !trailing) reviewed =/^--\s*rollback-reviewed:\s*(\S.*)$/i.exec(raw)?.[1].trim() ?? reviewed;
    } else if (rest.startsWith('/*')) {
      let depth = 1, end = 2;
      while (depth && end < rest.length) {
        if (rest.startsWith('/*', end)) { depth++; end += 2; }
        else if (rest.startsWith('*/', end)) { depth--; end += 2; }
        else end++;
      }
      if (depth) throw new Error(`Unterminated SQL comment at line ${line}`);
      raw = rest.slice(0, end);
    } else {
      if (!tokens.length) start = line;
      const dollar = /^\$(?:[a-z_][a-z_0-9]*)?\$/i.exec(rest)?.[0];
      const quoted = /^(?:E'(?:''|\\[\s\S]|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*")/i.exec(rest)?.[0];
      if (dollar) {
        const end = rest.indexOf(dollar, dollar.length);
        if (end === -1) throw new Error(`Unterminated SQL dollar quote at line ${line}`);
        raw = rest.slice(0, end + dollar.length); tokens.push('?');
      } else if (quoted) {
        raw = quoted; tokens.push(raw.startsWith('"') ? raw : '?');
      } else {
        if (/^['"]/.test(rest)) throw new Error(`Unterminated SQL quote at line ${line}`);
        raw = /^[a-z_][a-z_0-9$]*/i.exec(rest)?.[0] ?? rest[0];
        if (raw === ';') finish();
        else tokens.push(raw.toUpperCase());
      }
    }
    if (raw.includes('\n')) trailing = false;
    line += raw.split('\n').length - 1;
    index += raw.length;
  }
  finish();
  return result;
}

/** Split ALTER actions, ignoring keywords and commas inside expressions.
 * @param {string[]} tokens
 */
function actions(tokens) {
  const result = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === '(') depth++;
    else if (token === ')') depth--;
    else if (!depth) {
      if (token === ',') result.push([]);
      else result.at(-1).push(token);
    }
  }
  return result;
}

/** @param {string[]} tokens @param {string[]} phrase */
function contains(tokens, phrase) {
  return tokens.some((_, index) => phrase.every((token, offset) => tokens[index + offset] === token));
}

/** Static review triggers, not proof that arbitrary SQL or application readers are compatible.
 * @param {string} source
 * @returns {{line: number, rule: string}[]}
 */
export function rollbackFindings(source) {
  const findings = [];
  for (const statement of statements(source)) {
    const { tokens, line, reviewed } = statement;
    if (tokens[0] !== 'ALTER' || tokens[1] !== 'TABLE' || reviewed) continue;
    for (const action of actions(tokens)) {
      // A removed constraint may be a CHECK; its kind is not in DROP CONSTRAINT SQL.
      if (action.includes('CHECK') || contains(action, ['DROP', 'CONSTRAINT']))
        findings.push({ line, rule: 'changed CHECK (or dropped constraint): older readers may reject new stored values' });
      if (contains(action, ['SET', 'NOT', 'NULL']))
        findings.push({ line, rule: 'SET NOT NULL: verify a non-null DEFAULT for older inserts' });
      if (contains(action, ['DROP', 'DEFAULT']))
        findings.push({ line, rule: 'DROP DEFAULT: older inserts that omit a NOT NULL column fail' });
      const add = action.indexOf('ADD');
      if (add === -1) continue;
      const definition = action.slice(add + 1);
      if (definition[0] === 'COLUMN') definition.shift();
      if (definition.slice(0, 3).join(' ') === 'IF NOT EXISTS') definition.splice(0, 3);
      if (['CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'FOREIGN', 'EXCLUDE'].includes(definition[0])) continue;
      const required = definition.some((token, index) => token === 'NOT' && definition[index + 1] === 'NULL');
      const defaultIndex = definition.indexOf('DEFAULT');
      if (required && (defaultIndex === -1 || definition[defaultIndex + 1] === 'NULL'))
        findings.push({ line, rule: 'new NOT NULL column without a non-null DEFAULT: older inserts omit it' });
    }
  }
  return findings;
}

/** Inspect only added SQL blobs on the branch, never historical migrations or working files.
 * @param {string} base @param {string} head @param {string} cwd
 */
export function checkRollback(base, head = 'HEAD', cwd = process.cwd()) {
  if (!base || /^0+$/.test(base)) throw new Error('Give the main merge base');
  const paths = git(['diff', '--name-only', '--diff-filter=A', '--no-renames', '-z', base, head, '--', migrations], cwd, { raw: true })
    .split('\0').filter(path => path.endsWith('.sql'));
  const failures = [];
  for (const path of paths) {
    for (const finding of rollbackFindings(git(['show', `${head}:${path}`], cwd, { raw: true })))
      failures.push(`${path}:${finding.line}: ${finding.rule}`);
  }
  if (failures.length) throw new Error('Migration rollback review required:\n' + failures.join('\n') +
    '\nUse an expand-compatible migration, or document the major boundary / default and tolerant reader with a statement-level -- rollback-reviewed: reason. See docs/versioning.md.');
  return paths.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Checked rollback rules in ${checkRollback(process.argv[2] ?? '', process.argv[3] ?? 'HEAD')} new migrations.`);
}
