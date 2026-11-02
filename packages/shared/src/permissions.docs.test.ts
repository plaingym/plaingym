// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { memberPermissions, staffPermissions, staffRoles } from './permissions.js';

const page = readFileSync(fileURLToPath(new URL('../../../docs/security-model.md', import.meta.url)), 'utf8');

/** The `| \`capability\` | yes | | ... |` rows of the table under `heading`, as capability → granted columns. */
function table(heading: string): Record<string, boolean[]> {
  const start = page.indexOf(`\n### ${heading}\n`);
  if (start < 0) throw new Error(`Missing section ${heading}`);
  const next = page.indexOf('\n#', start + 1);
  const rows: Record<string, boolean[]> = {};
  for (const line of page.slice(start, next < 0 ? undefined : next).split('\n')) {
    const match = /^\| `([a-z_.]+)` \|(.*)\|$/.exec(line);
    if (match) rows[match[1]!] = match[2]!.split('|').map((cell) => cell.trim() === 'yes');
  }
  return rows;
}

describe('docs/security-model.md', () => {
  it('shows the staff capabilities exactly as granted', () => {
    const expected = Object.fromEntries(Object.entries(staffPermissions)
      .map(([capability, roles]) => [capability, staffRoles.map((role) => (roles as readonly string[]).includes(role))]));
    expect(table('Staff capabilities')).toEqual(expected);
  });
  it('shows the member capabilities exactly as granted', () => {
    const expected = Object.fromEntries(Object.entries(memberPermissions)
      .map(([capability, roles]) => [capability, ['payer', 'member'].map((role) => (roles as readonly string[]).includes(role))]));
    expect(table('Member capabilities')).toEqual(expected);
  });
});
