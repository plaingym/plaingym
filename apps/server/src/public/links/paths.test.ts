// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import * as contracts from '@plaingym/shared/contracts';

it('loads the signed-link session path for every signed-link contract', async () => {
  const source = await readFile(new URL('../../core/runtime.ts', import.meta.url), 'utf8');
  const match = /session: \(context, next\) => \/(.+)\/\.test\(context\.req\.path\)/.exec(source);
  expect(match, 'Keep this guard in step with the runtime session selection').not.toBeNull();
  const sessionPath = new RegExp(match![1]!);
  const paths: string[] = [];
  for (const [name, group] of Object.entries(contracts)) {
    if (!name.endsWith('Contracts') || !group || typeof group !== 'object') continue;
    for (const contract of Object.values(group) as { path?: string; permission?: { kind: string } }[]) {
      if (contract.permission?.kind !== 'signed_link') continue;
      paths.push(contract.path!);
      expect(sessionPath.test(contract.path!), name + ': ' + contract.path).toBe(true);
    }
  }
  expect(paths.length).toBeGreaterThan(0);
  expect(sessionPath.test('/api/links/send')).toBe(false);
  expect(sessionPath.test('/api/links')).toBe(false);
});
