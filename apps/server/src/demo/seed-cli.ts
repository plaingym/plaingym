// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, gyms } from '@plaingym/db';
import type { Command } from '../cli/index.js';
import { runSeeds } from './seed/index.js';
/** TODO(CCR): register this command and expose it as `pnpm seed <gym-uuid>`. */
export function createSeedCommand(scope: typeof forGym = forGym, seed = runSeeds): Command {
  return { id: 'seed', description: 'Apply sample content to a gym', async run(args, io) {
    if (args.length !== 1) { io.stderr('Usage: seed <gym-uuid>'); return 2; }
    try {
      const gymId = args[0]!;
      const [gym] = await scope(gymId, (tx) => tx.select({ timezone: gyms.timezone }).from(gyms).where(eq(gyms.id, gymId)));
      if (!gym) throw new Error('Gym not found');
      await seed({ gymId, timezone: gym.timezone, enabledModules: new Set() });
      io.stdout('Seed complete'); return 0;
    } catch { io.stderr('Unable to seed gym'); return 1; }
  } };
}
