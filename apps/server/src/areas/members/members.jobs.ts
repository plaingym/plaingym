// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import type { forGym } from '@plaingym/db';
import { idSchema } from '@plaingym/shared/contracts';
import { createMembersService } from './members.js';
import type { MemberUploads } from './photos.js';
import { createErasureJobs } from './members.routes.js';

/** Integration supplies the same gym-scoped uploads resolver used by the HTTP routes. */
export function createMemberPhotoJobs(uploadsFor: MemberUploads, scope?: typeof forGym): readonly JobRegistration[] {
  return [{ id: 'members.photos.cleanup', cron: '23 * * * *', async handler(_payload, context) {
    const uploads = await uploadsFor(context.gymId), prefix = `${context.gymId}/members/`;
    const service = createMembersService({ ...(scope ? { scope } : {}), clock: context.clock });
    for (const object of await uploads.list(prefix)) {
      // The age avoids interrupting normal uploads; correctness comes from the revision change below.
      if (object.deletedAt || object.createdAt.getTime() > context.clock.now().getTime() - 3_600_000) continue;
      const [memberId, version, ...extra] = object.key.slice(prefix.length).split('/');
      if (!idSchema.safeParse(memberId).success || !idSchema.safeParse(version).success || extra.length) continue;
      if (await service.retireUnusedPhoto({ gymId: context.gymId, actor: { kind: 'system' } }, memberId!, object.key))
        await uploads.markDeleted(object.key);
    }
  } }];
}

export const jobs: readonly JobRegistration[] = createErasureJobs();
