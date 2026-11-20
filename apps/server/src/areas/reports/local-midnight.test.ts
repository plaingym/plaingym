// SPDX-License-Identifier: AGPL-3.0-only
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverRoot = new URL('../../../', import.meta.url), root = fileURLToPath(serverRoot);
/** A calendar date converted to its gym-local midnight by hand instead of through localMidnight. */
const handWrittenMidnight = /zonedInstant\s*\([^\n;]*['"]00:00['"]/;

describe('gym-local midnight', () => {
  it('leaves no production call that hand-writes zonedInstant at 00:00', () => {
    const offenders = globSync('src/**/*.ts', { cwd: root })
      .filter(file => !/\.(?:test|spec)(?:-helper)?\.ts$/.test(file))
      .filter(file => handWrittenMidnight.test(readFileSync(new URL(file.replaceAll('\\', '/'), serverRoot), 'utf8')))
      .map(file => file.replaceAll('\\', '/'));
    expect(offenders).toEqual([]);
  });
});
