// SPDX-License-Identifier: AGPL-3.0-only
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function updatesLedger(source: string) {
  // Include quoted/qualified SQL names and table imports renamed by the caller.
  if (/\bupdate\s+(?:(?:"\w+"|\w+)\s*\.\s*)?"?class_credit_entries"?\b/i.test(source)) return true;
  const names = new Set(['classCreditEntries']);
  for (const match of source.matchAll(/\bclassCreditEntries\s+as\s+(\w+)/g)) names.add(match[1]!);
  // Follow simple local aliases too; namespace imports keep the property name.
  let previousSize = 0;
  while (previousSize !== names.size) {
    previousSize = names.size;
    for (const match of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:\w+\.)?(\w+)\b/g))
      if (names.has(match[2]!)) names.add(match[1]!);
  }
  return [...names].some(name => new RegExp('\\.update\\s*\\(\\s*(?:\\w+\\.)?' + name + '\\b').test(source));
}

describe('append-only credit ledger writers', () => {
  it.each([
    'tx.update(classCreditEntries)',
    'tx.update(schema.classCreditEntries)',
    'import { classCreditEntries as ledger } from "@plaingym/db"; tx.update(ledger)',
    'const ledger = schema.classCreditEntries; const rows = ledger; tx.update(rows)',
    'sql`update class_credit_entries set member_id = null`',
    'sql`UPDATE "public"."class_credit_entries" SET member_id = null`',
  ])('detects a ledger update: %s', source => { expect(updatesLedger(source)).toBe(true); });
  it('reserves updates to the erasure module', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const writers = globSync('**/*.{ts,tsx}', { cwd: root }).filter(file => !/\.(?:test|spec)\./.test(file))
      .filter(file => updatesLedger(readFileSync(new URL(file.replaceAll('\\', '/'), new URL('../../../', import.meta.url)), 'utf8')))
      .map(file => file.replaceAll('\\', '/'));
    expect(writers).toEqual(['areas/members/erasure-redaction.ts']);
  });
});
