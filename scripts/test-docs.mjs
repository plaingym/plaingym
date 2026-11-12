// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { createVitest } from 'vitest/node';

// Discover every project first: filtering to unit would silently omit a misplaced docs test.
const vitest = await createVitest('test', { watch: false, run: true, reporters: [] });
try {
  const docs = (await vitest.globTestSpecifications()).filter(spec => /\.docs\.test\.ts$/.test(spec.moduleId));
  if (!docs.length) throw new Error('No documentation tests found');
  const misplaced = docs.filter(spec => spec.project.name !== 'unit');
  if (misplaced.length) throw new Error(`Documentation tests must belong to unit: ${misplaced.map(spec => spec.moduleId).join(', ')}`);
} finally { await vitest.close(); }
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'unit', '.docs.test.ts'], { stdio: 'inherit', shell: true });
process.exitCode = result.status ?? 1;
