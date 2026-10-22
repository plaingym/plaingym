// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const allowed = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD',
  'MPL-2.0', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0',
]);

// Recursive descent preserves AND precedence, parentheses, and license exceptions.
// Unknown identifiers and exceptions fail closed; OR chooses an allowed alternative.
export function evaluate(expression, permits) {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  const tokens = expression.match(/\(|\)|[^\s()]+/g);
  let position = 0;
  function primary() {
    if (tokens[position] === '(') {
      position++;
      const value = or();
      if (tokens[position++] !== ')') throw new Error('Unclosed SPDX group');
      return value;
    }
    const identifier = tokens[position++];
    if (!identifier || !/^[A-Za-z0-9][A-Za-z0-9.+:-]*$/.test(identifier)
        || ['AND', 'OR', 'WITH'].includes(identifier)) throw new Error('Invalid SPDX identifier');
    if (tokens[position] === 'WITH') {
      position++;
      const exception = tokens[position++];
      if (!exception || ['AND', 'OR', 'WITH'].includes(exception) || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(exception)) throw new Error('Invalid exception');
      return permits(`${identifier} WITH ${exception}`);
    }
    return permits(identifier);
  }
  function and() {
    let result = primary();
    while (tokens[position] === 'AND') {
      position++;
      const next = primary();
      result = result && next;
    }
    return result;
  }
  function or() {
    let result = and();
    while (tokens[position] === 'OR') {
      position++;
      const next = and();
      result = result || next;
    }
    return result;
  }
  try {
    const result = or();
    return position === tokens.length && result;
  } catch {
    return false;
  }
}

export function noticeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(file.name))
    .map((file) => ({ name: file.name, text: readFileSync(join(directory, file.name), 'utf8').replace(/\r\n/g, '\n').trim() }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function detectLicense(text) {
  const spdx = [...text.matchAll(/SPDX-License-Identifier:\s*([^\r\n]+)/g)].map((match) => match[1].trim());
  if (spdx.length) return spdx.map((value) => `(${value})`).join(' AND ');
  const normalize = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const compact = normalize(text);
  // Match complete canonical text, rather than a permissive substring that
  // could overlook an added noncommercial or proprietary restriction.
  const lines = text.trim().split(/\r?\n/);
  const firstBody = lines.findIndex((line) => /^permission is hereby granted/i.test(line.trim()));
  const prefix = lines.slice(0, firstBody).filter((line) => line.trim());
  const template = readFileSync(new URL('./templates/MIT.txt', import.meta.url), 'utf8');
  const body = normalize(template.slice(template.indexOf('Permission is hereby granted')));
  if (firstBody >= 0 && prefix.every((line) => /^(?:(?:the )?mit license(?: \(mit\))?|copyright\b.*)$/i.test(line.trim()))
      && normalize(lines.slice(firstBody).join('\n')) === body) return 'MIT';
  for (const [license, filename] of [
    ['Apache-2.0', './notices/drizzle-orm-0.45.4.txt'],
    ['Unlicense', './notices/postgres-3.4.9.txt'],
  ]) {
    if (compact === normalize(readFileSync(new URL(filename, import.meta.url), 'utf8'))) return license;
  }
  return null;
}

export function packageLicense(manifest, notices) {
  if (Object.hasOwn(manifest, 'license')) {
    return typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
  }
  const licenses = notices.filter((file) => /^(licen[cs]e|copying)([._-].*)?$/i.test(file.name));
  if (!licenses.length) return null;
  const detected = licenses.map((file) => detectLicense(file.text));
  return detected.every(Boolean) ? detected.map((value) => `(${value})`).join(' AND ') : null;
}

export function validateApprovals(approvals) {
  if (!Array.isArray(approvals)) throw new Error('License approvals must be an array');
  for (const entry of approvals) {
    if (!entry.name || !entry.version || /[*^~<>|\s]/.test(entry.version)
        || !entry.license || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.approved ?? '')) {
      throw new Error('Approvals require an exact name/version/license, reason, and approved date (YYYY-MM-DD)');
    }
  }
}

export function licenseAllowed(pkg, approvals = []) {
  validateApprovals(approvals);
  // Approvals and the CC-BY-4.0 allowance cover build tools only: never shipped
  // in a production closure or either bundle (unknown bundle evidence fails closed).
  const buildOnly = pkg.runtime === false && pkg.bundled === false;
  if (buildOnly && approvals.some((entry) => entry.name === pkg.name && entry.version === pkg.version && entry.license === pkg.license)) return true;
  return evaluate(pkg.license, (identifier) => allowed.has(identifier)
    || (identifier === 'CC-BY-4.0' && pkg.buildTimeOnly === true && buildOnly)
    || (identifier === 'OFL-1.1' && pkg.kind === 'font' && /\.(ttf|otf|woff2?)$/i.test(pkg.path)));
}
export function assertLicenseAllowed(pkg, approvals = []) {
  if (!licenseAllowed(pkg, approvals)) throw new Error(`Disallowed license: ${pkg.name}@${pkg.version}: ${pkg.license ?? 'UNKNOWN (no recognizable LICENSE)'}`);
}
