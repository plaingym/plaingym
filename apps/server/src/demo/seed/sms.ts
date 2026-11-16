// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { auditEvents, forGym, gyms, households, members, smsOutbox, uuidv7, writeAudit } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { clock as defaultClock } from '../../core/clock.js';
import type { SeedStep } from './index.js';

const t = createTranslator(locales.en ?? {});
/** Fictional consent and numbers belong only to the sample dataset. No transport is constructed here. */
export function smsSeed(options: { scope?: typeof forGym; clock?: Clock } = {}): SeedStep {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return { id: 'sms', async run(context) {
    await scope(context.gymId, async tx => {
      const [gym] = await tx.select({ id: gyms.id, name: gyms.name, revision: gyms.revision }).from(gyms).where(eq(gyms.id, context.gymId)).for('update');
      if (!gym) throw new Error('Demo gym not found');
      const [seeded] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.action, 'demo.sms_seeded')).limit(1);
      if (seeded) return;
      const now = clock.now();
      const people = await tx.select({ id: members.id, householdId: members.householdId, revision: members.revision }).from(members)
        .where(and(eq(members.status, 'active'), isNotNull(members.phone))).orderBy(asc(members.id)).limit(3);
      for (const [index, person] of people.entries()) {
        // NANPA's reserved fictional range, never a real recipient.
        const phone = '+120255501' + String(10 + index).padStart(2, '0');
        await tx.update(members).set({ phone, phoneE164: phone, smsNoticesConsentAt: now, smsNoticesConsentSource: 'staff',
          smsAnnouncementsConsentAt: now, smsAnnouncementsConsentSource: 'portal', revision: person.revision + 1 }).where(eq(members.id, person.id));
        const [home] = await tx.select({ revision: households.revision }).from(households).where(eq(households.id, person.householdId)).for('update');
        if (home) await tx.update(households).set({ phone, phoneE164: phone, smsNoticesConsentAt: now,
          smsNoticesConsentSource: 'staff', revision: home.revision + 1 }).where(eq(households.id, person.householdId));
        const id = uuidv7(now.getTime());
        await tx.insert(smsOutbox).values({ gymId: context.gymId, id, recipient: phone,
          body: `${gym.name}: ${t('demo/demo:sampleText')}`, sentAt: now, createdAt: now });
        await writeAudit(tx, { gymId: context.gymId, actorKind: 'system', action: 'demo.sms_captured', targetType: 'sms_outbox', targetId: id, occurredAt: now });
      }
      await tx.update(gyms).set({ memberSmsEnabled: true, revision: gym.revision + 1, updatedAt: now }).where(eq(gyms.id, context.gymId));
      await writeAudit(tx, { gymId: context.gymId, actorKind: 'system', action: 'demo.sms_seeded', targetType: 'gym', targetId: context.gymId,
        after: { memberSmsEnabled: true, members: people.length }, occurredAt: now });
    });
  } };
}
