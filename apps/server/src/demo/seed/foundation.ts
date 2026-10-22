// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import { clock as defaultClock, type Clock } from '../../core/clock.js';
import { createContentPackService } from '../../areas/ranks/packs.js';
import { loadContentPacks } from '../../areas/ranks/packs.loader.js';
import type { SeedStep } from './index.js';

export function foundationSeed(options: { scope?: typeof forGym; clock?: Clock; packsDirectory?: string } = {}): SeedStep {
  return { id: 'foundation', async run(context) {
    const catalog = await loadContentPacks(options.packsDirectory);
    const pack = catalog.find((item) => item.id === 'bjj') ?? catalog[0];
    if (!pack) throw new Error('Demo seed requires a content pack');
    await createContentPackService({ scope: options.scope ?? forGym, clock: options.clock ?? defaultClock })
      .apply({ gymId: context.gymId, actor: { kind: 'system' } }, pack);
  } };
}
