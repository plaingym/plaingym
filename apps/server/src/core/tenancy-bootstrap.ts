// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { forSystem, gyms, gymDomains, uuidv7, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { encryptSecret } from './secrets.js';

/** The slug and normalized owner email identify a retry of this bootstrap only. */
export async function reserveGym(input: {
  name: string; slug: string; hostname: string; ownerEmail: string; timezone: string; currency: string;
}, options: { system: typeof forSystem; clock: Clock; key: Buffer }) {
  return options.system(async (tx) => {
    const id = uuidv7();
    const [created] = await tx.insert(gyms).values({ id, name: input.name, slug: input.slug, timezone: input.timezone, currency: input.currency,
      settings: { bootstrapOwnerEmail: input.ownerEmail },
      qrKey: encryptSecret(options.key, 'qr_key', randomBytes(32).toString('base64url')),
      createdAt: options.clock.now(), updatedAt: options.clock.now(),
    }).onConflictDoNothing({ target: gyms.slug }).returning({ id: gyms.id });
    if (created) {
      await tx.insert(gymDomains).values({ gymId: created.id, hostname: input.hostname, kind: 'default', verifiedAt: options.clock.now() });
      // System context creates the gym; its ID scopes the audit in the same transaction.
      await tx.execute(sql`select set_config('app.gym_id', ${created.id}, true)`);
      await writeAudit(tx, { gymId: created.id, actorKind: 'system', action: 'gym.created', targetType: 'gym', targetId: created.id, occurredAt: options.clock.now() });
      return created.id;
    }
    const [existing] = await tx.select({ id: gyms.id, name: gyms.name, timezone: gyms.timezone, currency: gyms.currency, status: gyms.status, settings: gyms.settings })
      .from(gyms).where(eq(gyms.slug, input.slug));
    const [domain] = existing ? await tx.select({ gymId: gymDomains.gymId }).from(gymDomains).where(eq(gymDomains.hostname, input.hostname)) : [];
    const settings = existing?.settings as { bootstrapOwnerEmail?: unknown } | undefined;
    if (!existing || existing.status !== 'active' || existing.name !== input.name || existing.timezone !== input.timezone
      || existing.currency !== input.currency || settings?.bootstrapOwnerEmail !== input.ownerEmail || domain?.gymId !== existing.id)
      throw new AppError('conflict', 'Gym details do not match the original bootstrap');
    return existing.id;
  });
}
