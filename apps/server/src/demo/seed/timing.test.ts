// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { runSeeds } from './index.js';

it('reports bounded seed-step and total timings without provider contents', async () => {
  const log = vi.fn(), now = vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(20).mockReturnValueOnce(70).mockReturnValueOnce(90);
  try {
    await runSeeds({ gymId: 'test-gym', timezone: 'UTC', enabledModules: new Set() }, [{ id: 'members', run: async () => {} }], { log });
    expect(log.mock.calls.map(([line]) => JSON.parse(line as string))).toEqual([
      { level: 'info', event: 'demo.seed_started', gymId: 'test-gym', step: 'members' },
      { level: 'info', event: 'demo.seed_completed', gymId: 'test-gym', step: 'members', elapsedMs: 50 },
      { level: 'info', event: 'demo.seed_completed_all', gymId: 'test-gym', elapsedMs: 80 },
    ]);
  } finally { now.mockRestore(); }
});
