// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { assertRevised, forGym, gyms, revisionGuard, writeAudit } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { normalizePhone } from '@plaingym/shared/phone';
import { saveSmsIntegrationRequestSchema, updateSmsDailyCapRequestSchema, settingsContracts, type UpdateSmsDailyCapRequest, type SaveSmsIntegrationRequest, type SmsIntegration } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { decryptSecret } from '../../core/secrets.js';
import { TwilioSms, type Sms } from '../../infra/sms/index.js';
import { encryptSmsConfig, storedSmsSchema, twilioBaseUrl, type StoredSmsConfig } from './sms.js';
import { readStoredSecret } from './unreadable-secret.js';
import { readGymSettings } from './settings.js';
import { route, type RouteRegistration } from '../../core/registry.js';
import type { IntegrationsService } from './integrations.js';

type Gym = typeof gyms.$inferSelect;
const t = createTranslator(locales.en ?? {});
export interface SmsIntegrationOptions {
  key: Buffer; scope: typeof forGym; clock: Clock; tenancy: 'single' | 'multi'; sandbox: boolean; editable: boolean;
  /** Tests replace the raw transport; owner tests deliberately bypass member consent, switches and caps. */
  smsFactory?: (config: StoredSmsConfig) => Sms;
}
export function createSmsIntegration(options: SmsIntegrationOptions) {
  const { scope, clock } = options;
  function read(gym: Gym) {
    if (options.sandbox) return null;
    return readStoredSecret(options.key, 'sms_config', gym.id, gym.smsConfig, () => {
      const config = storedSmsSchema.strip().parse(JSON.parse(decryptSecret(options.key, { secretClass: 'sms_config', owner: gym.id }, gym.smsConfig!)));
      if (options.tenancy === 'multi' && new URL(config.baseUrl ?? twilioBaseUrl).href !== twilioBaseUrl + '/') throw new Error('SMS provider unavailable');
      return config;
    });
  }
  function present(gym: Gym): SmsIntegration {
    const config = read(gym);
    return { configured: config !== null, provider: 'twilio', unreadable: !options.sandbox && !!gym.smsConfig && !config,
      accountSid: config?.accountSid ?? null, authKind: config ? 'token' in config.auth ? 'token' : 'apiKey' : null,
      from: config && 'from' in config.sender ? config.sender.from : null,
      messagingServiceSid: config && 'messagingServiceSid' in config.sender ? config.sender.messagingServiceSid : null,
      ...(options.tenancy === 'single' ? { baseUrl: config?.baseUrl ?? twilioBaseUrl } : {}) };
  }
  // Explicit projection: neither credentials, provider errors, test recipient nor text enter an audit.
  const audit = (gym: Gym) => {
    const value = present(gym);
    return { accountSid: value.accountSid, authKind: value.authKind, from: value.from, messagingServiceSid: value.messagingServiceSid };
  };
  function actor(context: MutationContext) {
    if (options.sandbox) throw new AppError('forbidden', 'SMS settings cannot change in a sandbox');
    if (!options.editable) throw new AppError('forbidden', 'The operator manages integrations', { integrations: ['operator_managed'] });
    if (context.actor.kind !== 'user') throw new AppError('forbidden', 'Owner access required');
    return context.actor.userId;
  }
  async function current(gymId: string, revision: number) {
    const [gym] = await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
    if (!gym) throw new AppError('not_found', 'Gym not found');
    assertRevised(gym.revision === revision ? [gym] : []);
    return gym;
  }
  async function update(context: MutationContext, revision: number, config: StoredSmsConfig | null) {
    const userId = actor(context);
    await scope(context.gymId, async tx => {
      const [before] = await tx.select().from(gyms).where(eq(gyms.id, context.gymId)).for('update');
      if (!before) throw new AppError('not_found', 'Gym not found');
      assertRevised(before.revision === revision ? [before] : []);
      if (!config && !before.smsConfig) throw new AppError('conflict', 'The gym has no SMS settings', { sms: ['not_configured'] });
      const guard = revisionGuard(gyms.revision, revision);
      const after = assertRevised(await tx.update(gyms).set({
        smsConfig: config ? encryptSmsConfig(options.key, context.gymId, config) : null, revision: guard.next, updatedAt: clock.now(),
      }).where(and(eq(gyms.id, context.gymId), guard.matches)).returning());
      await writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: userId,
        action: config ? 'integrations.sms_saved' : 'integrations.sms_removed', targetType: 'gym', targetId: context.gymId,
        before: audit(before), after: audit(after), occurredAt: clock.now() });
    });
  }
  return { present,
    async updateDailyCap(context: MutationContext, input: UpdateSmsDailyCapRequest) {
      const userId = actor(context);
      const { revision, smsDailyCap } = updateSmsDailyCapRequestSchema.parse(input);
      return scope(context.gymId, async tx => {
        const [before] = await tx.select({ revision: gyms.revision, smsDailyCap: gyms.smsDailyCap }).from(gyms)
          .where(eq(gyms.id, context.gymId)).for('update');
        if (!before) throw new AppError('not_found', t('settings/go-live:notFound'));
        assertRevised(before.revision === revision ? [before] : []);
        const guard = revisionGuard(gyms.revision, revision);
        assertRevised(await tx.update(gyms).set({ smsDailyCap, revision: guard.next, updatedAt: clock.now() })
          .where(and(eq(gyms.id, context.gymId), guard.matches)).returning({ id: gyms.id }));
        await writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: userId,
          action: 'integrations.sms_daily_cap_updated', targetType: 'gym', targetId: context.gymId,
          before: { smsDailyCap: before.smsDailyCap }, after: { smsDailyCap }, occurredAt: clock.now() });
        return readGymSettings(tx, context.gymId);
      });
    },
    async save(context: MutationContext, input: SaveSmsIntegrationRequest): Promise<'sent' | 'failed'> {
      const userId = actor(context);
      const parsed = saveSmsIntegrationRequestSchema.parse(input);
      const gym = await current(context.gymId, parsed.revision);
      const baseUrl = new URL(parsed.baseUrl ?? twilioBaseUrl).href.replace(/\/$/, '');
      if (options.tenancy === 'multi' && baseUrl !== twilioBaseUrl)
        throw new AppError('invalid_request', 'Use the Twilio provider URL', { baseUrl: ['twilio_only'] });
      const address = gym.address as { country?: unknown };
      const country = typeof address.country === 'string' ? address.country : undefined;
      const testTo = normalizePhone(parsed.testTo, country);
      const from = 'from' in parsed.sender ? normalizePhone(parsed.sender.from, country) : null;
      if (!testTo || ('from' in parsed.sender && !from))
        throw new AppError('invalid_request', 'Enter a valid phone number with its country code', { phone: ['invalid_phone'] });
      const config = storedSmsSchema.parse({ accountSid: parsed.accountSid, auth: parsed.auth,
        sender: from ? { from } : parsed.sender, baseUrl });
      // Network work happens after the revision read committed and before the encrypted write.
      let test: 'sent' | 'failed' = 'sent';
      try {
        const sms = options.smsFactory?.(config) ?? new TwilioSms(config);
        await sms.verifyAccount();
        const result = await sms.sendSms({ to: testTo, body: `${gym.name}: ${t('settings/integrations:sms.testBody')}` });
        if (result.status !== 'sent') throw new Error('Test not accepted');
      } catch {
        test = 'failed';
      }
      // The outcome is audited on its own, so a text the provider accepted stays recorded even if the save then conflicts.
      await scope(context.gymId, tx => writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: userId,
        action: 'integrations.sms_tested', targetType: 'gym', targetId: context.gymId, after: { test }, occurredAt: clock.now() }));
      if (test === 'failed') return 'failed';
      await update(context, parsed.revision, config);
      return 'sent';
    },
    async remove(context: MutationContext, revision: number) { await update(context, revision, null); },
  };
}

export function createSmsDailyCapRoutes(current: () => Pick<IntegrationsService, 'updateSmsDailyCap'>): RouteRegistration[] {
  const contract = settingsContracts.updateSmsDailyCap;
  return [route({ ...contract,
    request: { body: { required: true, content: { 'application/json': { schema: contract.body } } } },
    responses: { 200: { description: 'Updated SMS daily cap', content: { 'application/json': { schema: contract.response } } } },
  }, async c => {
    const { gym, principal } = c.get('context');
    if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', t('settings/go-live:notFound'));
    return c.json({ data: await current().updateSmsDailyCap({ gymId: gym.gymId, actor: { kind: 'user', userId: principal.userId } }, c.req.valid('json')) }, 200);
  })];
}
