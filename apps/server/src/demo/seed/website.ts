// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { demoWebsiteLogoUrl, demoWebsitePhotoUrl } from '../../assets.js';
import { createWebsiteService, type WebsiteOptions } from '../../modules/website/service.js';
import type { SeedStep } from './index.js';

/** Uses only the trusted seed upload resolver, never the visitor upload allowance. */
export function websiteSeed(options: WebsiteOptions): SeedStep {
  return { id: 'website', async run(context) {
    const service = createWebsiteService(options);
    const actor = { gymId: context.gymId, actor: { kind: 'system' as const } };
    let current = await service.settings(context.gymId);
    // Preserve an owner's edits, and resume after either upload if seeding was interrupted.
    if (!current.photos.length) {
      const bytes = await readFile(demoWebsitePhotoUrl);
      current = await service.uploadPhoto(actor, { revision: current.revision, contentType: 'image/jpeg',
        base64: bytes.toString('base64'), alt: 'Sunlit training mats in a sample martial arts academy' });
    }
    if (!current.logo) {
      const bytes = await readFile(demoWebsiteLogoUrl);
      await service.uploadLogo(actor, { revision: current.revision, contentType: 'image/png', base64: bytes.toString('base64') });
    }
  } };
}
