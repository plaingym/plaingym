// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const portal = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) && !/\.test(\.|-helper\.)|\/tests\//.test(path.replaceAll('\\', '/')) ? [path] : [];
});
const files = sources(portal).map(path => ({ path: relative(portal, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }));
// The portal-access tab is a staff page: it names its household explicitly and is not part of a login's portal.
const pages = files.filter(file => /\buse(Infinite)?Query\(/.test(file.text) && !/^(household\/api\.ts|shell\/|access\/)/.test(file.path));

/**
 * Every query key a page writes, or invalidates by, that is not built from the open household's key: anything but
 * `[...scope.key, '<segment>', ...]`, and any key in the shell's reserved `shell` segment.
 */
function strayKeys(text: string) {
  return [...text.matchAll(/\bqueryKey\b(\s*[:,})])\s*([^\n]{0,60})/g)].flatMap(([match, separator, value]) =>
    separator?.trim() === ':' && /^\[\s*\.\.\.scope\.key\s*,\s*'(?!shell')[\w-]+'/.test(value ?? '') ? [] : [match.trim()]);
}
/** Calls that read the open household (the household lists): a page makes one, and passes the scope to what needs it. */
const householdReads = (text: string) => [...text.matchAll(/(?<!function )\busePortal(Scope|Members)\(/g)].length;

describe('portal query keys', () => {
  it('writes the portal key base only in `household/api.ts`, whose helpers `usePortalScope` and the shell use', () => {
    const writers = files.filter(file => /\[\s*'portal'\s*,/.test(file.text)).map(file => file.path);
    expect(writers).toEqual(['household/api.ts']);
  });
  it('builds every portal page query key from the open household\'s key, outside the shell\'s segment', () => {
    expect(pages.map(file => file.path).sort()).toEqual(['billing/page.tsx', 'household/page.tsx', 'progress/page.tsx', 'schedule/members.tsx', 'schedule/page.tsx', 'checkin/page.tsx', 'waivers/page.tsx'].sort());
    for (const page of pages) {
      expect(strayKeys(page.text), page.path).toEqual([]);
      expect(page.text, page.path).toMatch(/\busePortal(Scope|Members)\(|\bscope: PortalScope\b/);
    }
  });
  it('reads the open household once per page', () => {
    for (const page of pages) expect(householdReads(page.text), page.path).toBeLessThanOrEqual(1);
    // Pages that need the role share one context query, through the hook that reads the household.
    for (const page of ['household/page.tsx', 'waivers/page.tsx', 'schedule/members.tsx'])
      expect(files.find(file => file.path === page)!.text, page).toMatch(/\busePortalContext\(scope\b/);
  });
  it('keeps the shell\'s own household entries in its reserved segment', () => {
    const shell = files.find(file => file.path === 'shell/shell.tsx')!.text;
    const keys = [...shell.matchAll(/\[\s*\.\.\.(householdKey|portalHouseholdKey\([^)]*\))\s*,\s*'([\w-]+)'/g)].map(match => match[2]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(segment => segment === 'shell')).toBe(true);
  });
  it('catches a page key not built from the portal key', () => {
    expect(strayKeys("useQuery({ queryKey: [...scope.key, 'billing', offset], queryFn })")).toEqual([]);
    for (const text of ["useQuery({ queryKey: ['billing', offset] })", "useQuery({ queryKey: [...base, 'billing'] })", "useQuery({ queryKey: codeKey })",
      "useQuery({ queryKey: [...scope.key, 'shell', 'context'] })", 'cache.invalidateQueries({ queryKey })', "useQuery({ queryKey: [...scope.key] })"])
      expect(strayKeys(text), text).toHaveLength(1);
    expect(householdReads('const scope = usePortalScope(); const again = usePortalScope();')).toBe(2);
  });
});
