// SPDX-License-Identifier: AGPL-3.0-only
import { pathToFileURL } from 'node:url';
import { git } from './version.mjs';
import { assertMigrationBase, migrations } from './migration-files.mjs';

/** Tokenize declarative migration SQL, keeping literals opaque and statement boundaries intact.
 * Preserve literal spellings separately for naming a sequence in setval findings.
 * @param {string} source
 */
function statements(source) {
  const result = [];
  // `trailing` is set after a `;` until the next line, so a comment after a statement can't review the next one.
  let tokens = [], literals = new Map(), line = 1, start = 1, reviewed = '', index = 0, trailing = false;
  const finish = () => {
    if (tokens.length) result.push({ tokens, literals, line: start, reviewed });
    tokens = []; literals = new Map(); reviewed = ''; trailing = true;
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
        raw = rest.slice(0, end + dollar.length);
        literals.set(tokens.length, raw);
        tokens.push('?');
      } else if (quoted) {
        raw = quoted;
        if (!raw.startsWith('"')) literals.set(tokens.length, raw);
        tokens.push(raw.startsWith('"') ? raw : '?');
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

/** @param {string} token */
function identifierName(token) {
  return token.startsWith('"') ? token : token.toLowerCase();
}

/** @param {string[]} tokens @param {number} start */
function qualifiedNameEnd(tokens, start) {
  let end = start + 1;
  while (tokens[end] === '.') end += 2;
  return end;
}

const sequenceOptions = ['RESTART', 'START', 'INCREMENT', 'CYCLE', 'MAXVALUE', 'MINVALUE'];

/** @param {string[]} tokens */
function sequenceAlterations(tokens) {
  const start = tokens[2] === 'IF' && tokens[3] === 'EXISTS' ? 4 : 2;
  const end = qualifiedNameEnd(tokens, start);
  if (['OWNER', 'RENAME', 'SET'].includes(tokens[end])) return [];
  const name = tokens.slice(start, end).map(identifierName).join('');
  const rules = [];
  for (let index = end; index < tokens.length; index++) {
    const option = tokens[index];
    if (option === 'OWNED' || option === 'AS') {
      const argument = index + (option === 'OWNED' ? 2 : 1);
      index = qualifiedNameEnd(tokens, argument) - 1;
    } else if (sequenceOptions.includes(option)) {
      const label = tokens[index - 1] === 'NO' ? `NO ${option}` : option;
      rules.push(`ALTER SEQUENCE ${label} on ${name}: older inserts may exhaust the sequence or receive conflicting values`);
    }
  }
  return rules;
}

/** @param {string[]} tokens @param {Map<number, string>} literals */
function setvalCalls(tokens, literals) {
  const rules = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!['SETVAL', '"setval"'].includes(tokens[index]) || tokens[index + 1] !== '(') continue;
    let beforeName = index - 1;
    while (tokens[beforeName] === '.') beforeName -= 2;
    // A relation name may also be followed by a column list.
    if (['TABLE', 'INTO', 'REFERENCES'].includes(tokens[beforeName]) ||
        tokens.slice(beforeName - 3, beforeName + 1).join(' ') === 'TABLE IF NOT EXISTS') continue;
    const argument = index + 2;
    const literal = [',', ':'].includes(tokens[argument + 1]) ? literals.get(argument) : undefined;
    const name = literal?.startsWith("'") ? literal.slice(1, -1).replaceAll("''", "'") : literal;
    rules.push(`setval on ${name ?? 'a computed sequence'}: older inserts may receive conflicting sequence values`);
  }
  return rules;
}

// Identity options can be combined in one ALTER COLUMN action.
const identityOptions = ['CACHE', 'CYCLE', 'GENERATED', 'INCREMENT', 'LOGGED', 'MAXVALUE', 'MINVALUE', 'NO', 'START', 'UNLOGGED'];

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
    const { tokens, literals, line, reviewed } = statement;
    if (reviewed) continue;
    for (const rule of setvalCalls(tokens, literals)) findings.push({ line, rule });
    if (tokens[0] !== 'ALTER') continue;
    if (tokens[1] === 'SEQUENCE') {
      for (const rule of sequenceAlterations(tokens)) findings.push({ line, rule });
    }
    if (tokens[1] !== 'TABLE') continue;
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
        const name = identifierName(alteredColumn);
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
        if (change[0] === 'SET' && change[1] === 'EXPRESSION')
          findings.push({ line, rule: `SET EXPRESSION on ${name}: older readers may receive different generated values` });
        if (change[0] === 'RESTART' || (change[0] === 'SET' && identityOptions.includes(change[1]))) {
          if (change.includes('RESTART'))
            findings.push({ line, rule: `RESTART on ${name}: older inserts that omit the column may receive conflicting sequence values` });
          if (contains(change, ['SET', 'START']))
            findings.push({ line, rule: `SET START on ${name}: a later restart may give older inserts conflicting sequence values` });
          if (contains(change, ['SET', 'INCREMENT']))
            findings.push({ line, rule: `SET INCREMENT BY on ${name}: older inserts that omit the column may receive conflicting sequence values` });
          if (contains(change, ['SET', 'CYCLE']))
            findings.push({ line, rule: `SET CYCLE on ${name}: older inserts may receive conflicting sequence values after wraparound` });
          for (const bound of ['MAXVALUE', 'MINVALUE']) {
            if (contains(change, ['SET', bound]))
              findings.push({ line, rule: `SET ${bound} on ${name}: older inserts may exhaust the sequence or receive conflicting values` });
          }
          for (const option of ['CYCLE', 'MAXVALUE', 'MINVALUE']) {
            if (contains(change, ['SET', 'NO', option]))
              findings.push({ line, rule: `SET NO ${option} on ${name}: older inserts may exhaust the sequence or receive conflicting values` });
          }
        }
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
