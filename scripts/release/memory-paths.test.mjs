// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { needsMemory } from './memory-paths.mjs';

test('task memory checks cover PDF, waiver, rate-limit and deployment changes', () => {
  for (const file of ['apps/server/src/infra/pdf/render.ts', 'apps/server/src/areas/waivers/pdf.ts',
    'apps/server/src/core/rate-limit.ts', 'apps/server/src/core/rate-limit.test.ts', 'deploy/Dockerfile', '.github/workflows/memory.yml'])
    assert.equal(needsMemory('refs/heads/task/example', ['docs/guide.md', file]), true, file);
  assert.equal(needsMemory('refs/heads/task/example', ['apps/web/src/components/button.tsx', 'docs/guide.md']), false);
  for (const ref of ['refs/heads/main', 'refs/heads/integration/example'])
    assert.equal(needsMemory(ref, ['apps/web/src/components/button.tsx']), true);
});
