// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const portal = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) && !/\.test(\.|-helper\.)|\/tests\//.test(path.replaceAll('\\', '/')) ? [path] : [];
});
const files = sources(portal).map(path => ({ path: relative(portal, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }));

it('writes the portal key base only in `household/api.ts`, whose helpers `usePortalKey` and the shell use', () => {
  const writers = files.filter(file => /\[\s*'portal'\s*,/.test(file.text)).map(file => file.path);
  expect(writers).toEqual(['household/api.ts']);
});
it('builds every portal page query key from `usePortalKey`, directly or through `usePortalMembers`', () => {
  // The portal-access tab is a staff page: it names its household explicitly and is not part of a login's portal.
  const pages = files.filter(file => /\buse(Infinite)?Query\(/.test(file.text) && !/^(household\/api\.ts|shell\/|access\/)/.test(file.path));
  expect(pages.map(file => file.path).sort()).toEqual(['billing/page.tsx', 'household/page.tsx', 'progress/page.tsx', 'schedule/members.tsx', 'schedule/page.tsx', 'checkin/page.tsx', 'waivers/page.tsx'].sort());
  for (const page of pages) expect(page.text, page.path).toMatch(/\buse(PortalKey|PortalMembers)\(/);
});
