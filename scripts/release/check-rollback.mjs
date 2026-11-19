// SPDX-License-Identifier: AGPL-3.0-only
import { pathToFileURL } from 'node:url';
import { git } from './version.mjs';
import { assertMigrationBase, migrations } from './migration-files.mjs';

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

/** Split ALTER actions, keeping each parenthesized expression as one opaque token.
 * @param {string[]} tokens @param {number} line
 */
function actions(tokens, line) {
  const result = [[]];
  let depth = 0;
  let expression = [];
  for (const token of tokens) {
    if (token === '(') depth++;
    if (depth) {
      expression.push(token);
      if (token === ')' && --depth === 0) {
        result.at(-1).push(expression.join(' '));
        expression = [];
      }
    } else {
      if (token === ')') throw new Error(`Unmatched SQL parenthesis in the statement at line ${line}`);
      else if (token === ',') result.push([]);
      else result.at(-1).push(token);
    }
  }
  if (depth) throw new Error(`Unterminated SQL parenthesis in the statement at line ${line}`);
  return result;
}

/** @param {string[]} tokens @param {string[]} phrase */
function contains(tokens, phrase) {
  return tokens.some((_, index) => phrase.every((token, offset) => tokens[index + offset] === token));
}

/** Whether the DEFAULT expression starting at `index` is a literal NULL: bare, parenthesized, or cast
 * (`NULL::text`, `(NULL)::text`, `CAST(NULL AS text)`).
 * @param {string[]} tokens @param {number} index
 */
function nullDefault(tokens, index) {
  const words = (/** @type {string} */ token) => token.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
  const value = tokens[index] === 'CAST' ? ['CAST', ...words(tokens[index + 1] ?? '')] : words(tokens[index] ?? '');
  if (value[0] === 'CAST') return value[1] === 'NULL' && value[2] === 'AS';
  return value[0] === 'NULL' && (value.length === 1 || (value[1] === ':' && value[2] === ':'));
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
    for (const action of actions(tokens, line)) {
      // A removed constraint may be a CHECK; its kind is not in DROP CONSTRAINT SQL.
      if (action.includes('CHECK') || contains(action, ['DROP', 'CONSTRAINT']))
        findings.push({ line, rule: 'changed CHECK (or dropped constraint): older readers may reject new stored values' });
      if (contains(action, ['SET', 'NOT', 'NULL']))
        findings.push({ line, rule: 'SET NOT NULL: verify a non-null DEFAULT for older inserts' });
      if (contains(action, ['DROP', 'NOT', 'NULL']))
        findings.push({ line, rule: 'DROP NOT NULL: older readers may reject null stored values' });
      // These rules apply to ALTER [COLUMN] actions on existing columns.
      const alter = action.lastIndexOf('ALTER');
      const alteration = alter === -1 ? [] : action.slice(alter + 1);
      if (alteration[0] === 'COLUMN') alteration.shift();
      const [alteredColumn, ...change] = alteration;
      if (alteredColumn && !['TABLE', 'CONSTRAINT'].includes(alteredColumn)) {
        const name = alteredColumn.startsWith('"') ? alteredColumn : alteredColumn.toLowerCase();
        if (change[0] === 'TYPE' || contains(change, ['SET', 'DATA', 'TYPE']))
          findings.push({ line, rule: 'SET DATA TYPE (or TYPE): older readers may reject new stored values' });
        if (change[0] === 'DROP' && change[1] === 'IDENTITY')
          findings.push({ line, rule: `DROP IDENTITY on ${name}: older inserts that omit the column lose its generated value and fail` });
        if (change[0] === 'ADD' && change[1] === 'GENERATED' && contains(change, ['AS', 'IDENTITY']))
          findings.push({ line, rule: `ADD GENERATED AS IDENTITY on ${name}: older inserts may fail on an explicit value or a conflicting sequence value` });
        if (contains(change, ['SET', 'GENERATED', 'ALWAYS']))
          findings.push({ line, rule: `SET GENERATED ALWAYS on ${name}: older inserts that supply a value are rejected` });
        if (change[0] === 'DROP' && change[1] === 'EXPRESSION')
          findings.push({ line, rule: `DROP EXPRESSION on ${name}: older inserts that omit the column lose its computed value` });
      }
      if (contains(action, ['DROP', 'DEFAULT']))
        findings.push({ line, rule: 'DROP DEFAULT: older inserts that omit a NOT NULL column fail' });
      const setDefault = action.findIndex((token, index) => token === 'SET' && action[index + 1] === 'DEFAULT');
      if (setDefault !== -1 && nullDefault(action, setDefault + 2))
        findings.push({ line, rule: 'SET DEFAULT NULL: older inserts that omit a NOT NULL column fail' });
      const add = action.indexOf('ADD');
      if (add === -1) continue;
      const definition = action.slice(add + 1);
      if (definition[0] === 'COLUMN') definition.shift();
      if (definition.slice(0, 3).join(' ') === 'IF NOT EXISTS') definition.splice(0, 3);
      const constraint = definition[0] === 'CONSTRAINT' ? definition.slice(2) : definition;
      if (contains(constraint.slice(0, 2), ['NOT', 'NULL']))
        findings.push({ line, rule: 'NOT NULL constraint: verify a non-null DEFAULT for older inserts' });
      if (contains(constraint.slice(0, 2), ['PRIMARY', 'KEY']))
        findings.push({ line, rule: 'PRIMARY KEY constraint: verify non-null DEFAULTs for older inserts' });
      if (['CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'FOREIGN', 'EXCLUDE', 'NOT'].includes(definition[0])) continue;
      const column = definition.slice(2);
      const required = contains(column, ['NOT', 'NULL']) || contains(column, ['PRIMARY', 'KEY']);
      const filled = /^(?:SMALLSERIAL|SERIAL|BIGSERIAL|SERIAL[248])$/.test(definition[1] ?? '') ||
        contains(column, ['GENERATED', 'ALWAYS', 'AS']) || contains(column, ['GENERATED', 'BY', 'DEFAULT', 'AS', 'IDENTITY']);
      const defaultIndex = definition.indexOf('DEFAULT');
      if (required && !filled && (defaultIndex === -1 || nullDefault(definition, defaultIndex + 1)))
        findings.push({ line, rule: 'new NOT NULL column without a non-null DEFAULT: older inserts omit it' });
    }
  }
  return findings;
}

/** Inspect only added SQL blobs on the branch, never historical migrations or working files.
 * @param {string} base @param {string} head @param {string} cwd
 */
export function checkRollback(base, head = 'HEAD', cwd = process.cwd()) {
  assertMigrationBase(base);
  const paths = git(['diff', '--name-only', '--diff-filter=A', '--no-renames', '-z', base, head, '--', migrations], cwd, { raw: true })
    .split('\0').filter(path => path.endsWith('.sql'));
  const failures = [];
  for (const path of paths) {
    let findings;
    try {
      findings = rollbackFindings(git(['show', `${head}:${path}`], cwd, { raw: true }));
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    for (const finding of findings) failures.push(`${path}:${finding.line}: ${finding.rule}`);
  }
  if (failures.length) throw new Error('Migration rollback review required:\n' + failures.join('\n') +
    '\nUse an expand-compatible migration, or document the major boundary / default and tolerant reader with a statement-level -- rollback-reviewed: reason. See docs/versioning.md.');
  return paths.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Checked rollback rules in ${checkRollback(process.argv[2] ?? '', process.argv[3] ?? 'HEAD')} new migrations.`);
}
