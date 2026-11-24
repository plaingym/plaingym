// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, gyms, writeAudit } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { callingCodeOf, normalizePhone, normalizePhoneWithCallingCode, supportedCountry } from '@plaingym/shared/phone';
import { updateSmsDailyCapRequestSchema, type UpdateSmsDailyCapRequest, type SaveSmsIntegrationRequest, type SmsIntegration,
  type SmsTestFailure } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { logError } from '../../core/log.js';
import { DeliveryError, SmsDeliveryError, TwilioSms, type Sms } from '../../infra/sms/index.js';
import { encryptSmsConfig, readSmsConfig, storedSmsSchema, twilioBaseUrl, type StoredSmsConfig } from './sms.js';
import { readGymSettings } from './settings.js';
import type { IntegrationSave } from './integrations.js';

type Gym = typeof gyms.$inferSelect;
const t = createTranslator(locales.en ?? {});
export interface SmsIntegrationOptions {
  key: Buffer; scope: typeof forGym; clock: Clock; tenancy: 'single' | 'multi'; sandbox: boolean;
  assertChangeable: () => void;
  userOf: (context: MutationContext) => string;
  assertCurrent: (gymId: string, revision: number) => Promise<Gym>;
  save: IntegrationSave;
  /** Tests replace the raw transport; owner tests deliberately bypass member consent, switches and caps. */
  smsFactory?: (config: StoredSmsConfig) => Sms;
}
const authenticationCodes = new Set([20003, 20008]), trialCodes = new Set([572006, 21608]);
const senderCodes = new Set([21212, 21606, 21659, 21660]), recipientCodes = new Set([21211, 21408, 21612, 21614]);
/**
 * Names why the provider refused an owner's SMS test, from its HTTP status and numeric error code; `undefined` when
 * the error carries no provider answer or the answer names no known cause.
 */
export function smsTestFailure(error: unknown): SmsTestFailure | undefined {
  const provider = error instanceof SmsDeliveryError ? error.provider : undefined;
  if (!provider) return undefined;
  const { httpStatus, code } = provider;
  if (httpStatus === null) return 'unreachable';
  if ((code !== null && authenticationCodes.has(code)) || httpStatus === 401 || httpStatus === 403) return 'authentication';
  if (code === null) return undefined;
  if (trialCodes.has(code)) return 'trial_account';
  if (code === 21610) return 'opted_out';
  if (senderCodes.has(code)) return 'sender';
  if (recipientCodes.has(code)) return 'recipient';
  return undefined;
}
export function createSmsIntegration(options: SmsIntegrationOptions) {
  const { scope, clock } = options;
  function read(gym: Gym) {
    if (options.sandbox) return null;
    return readSmsConfig(options.key, options.tenancy, gym.id, gym.smsConfig);
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
  const audit = (config: StoredSmsConfig | null) => ({ accountSid: config?.accountSid ?? null,
    authKind: config ? 'token' in config.auth ? 'token' : 'apiKey' : null,
    from: config && 'from' in config.sender ? config.sender.from : null,
    messagingServiceSid: config && 'messagingServiceSid' in config.sender ? config.sender.messagingServiceSid : null });
  async function update(context: MutationContext, gym: Gym, config: StoredSmsConfig | null) {
    if (!config && !gym.smsConfig) throw new AppError('conflict', 'The gym has no SMS settings', { sms: ['not_configured'] });
    // Read/decrypt before taking the write lock; the shared save rechecks this gym revision.
    const before = audit(read(gym)), after = audit(config);
    const smsConfig = config ? encryptSmsConfig(options.key, context.gymId, config) : null;
    await options.save(context, gym.revision, async () => ({ set: { smsConfig },
      action: config ? 'integrations.sms_saved' : 'integrations.sms_removed', before, after: () => after }));
  }
  return { present,
    async updateDailyCap(context: MutationContext, input: UpdateSmsDailyCapRequest) {
      options.userOf(context);
      const { revision, smsDailyCap } = updateSmsDailyCapRequestSchema.parse(input);
      await options.save(context, revision, async before => ({ set: { smsDailyCap },
        action: 'integrations.sms_daily_cap_updated', before: { smsDailyCap: before.smsDailyCap }, after: () => ({ smsDailyCap }) }));
      return scope(context.gymId, tx => readGymSettings(tx, context.gymId));
    },
    async save(context: MutationContext, input: SaveSmsIntegrationRequest): Promise<{ test: 'sent' | 'failed'; failure?: SmsTestFailure }> {
      options.assertChangeable();
      const userId = options.userOf(context);
      const gym = await options.assertCurrent(context.gymId, input.revision);
      const baseUrl = new URL(input.baseUrl ?? twilioBaseUrl).href.replace(/\/$/, '');
      if (options.tenancy === 'multi' && baseUrl !== twilioBaseUrl)
        throw new AppError('invalid_request', 'Use the Twilio provider URL', { baseUrl: ['twilio_only'] });
      const address = gym.address as { country?: unknown };
      const country = supportedCountry(address.country);
      const from = 'from' in input.sender ? normalizePhone(input.sender.from, country) : null;
      // With no gym country, the owner's test number may be typed nationally: it takes the From number's calling code.
      const fromCode = country ? null : callingCodeOf(from);
      const testTo = fromCode ? normalizePhoneWithCallingCode(input.testTo, fromCode) : normalizePhone(input.testTo, country);
      if (!testTo || ('from' in input.sender && !from))
        throw new AppError('invalid_request', 'Enter a valid phone number with its country code', { phone: ['invalid_phone'] });
      const config = storedSmsSchema.parse({ accountSid: input.accountSid, auth: input.auth,
        sender: from ? { from } : input.sender, baseUrl });
      // Network work happens after the revision read committed and before the encrypted write.
      let test: 'sent' | 'failed' = 'sent', failure: SmsTestFailure | undefined;
      let step: 'account' | 'send' = 'account';
      try {
        const sms = options.smsFactory?.(config) ?? new TwilioSms(config);
        await sms.verifyAccount();
        step = 'send';
        const result = await sms.sendSms({ to: testTo, body: `${gym.name}: ${t('settings/integrations:sms.testBody')}` });
        if (result.status !== 'sent') {
          logError('settings.sms_test_failed', { errorName: 'SmsSuppressed', providerStatus: result.status, step,
            providerHttpStatus: null, providerCode: null });
          test = 'failed';
        }
      } catch (error) {
        // A provider refusal, including the adapter's own message check, fails the test; anything else is a 500.
        if (!(error instanceof DeliveryError)) throw error;
        // Only the HTTP status and the integer code are logged: the provider's text can quote phone numbers.
        const provider = error instanceof SmsDeliveryError ? error.provider : undefined;
        logError('settings.sms_test_failed', { errorName: error.name, providerStatus: error.acceptance, step,
          providerHttpStatus: provider?.httpStatus ?? null, providerCode: provider?.code ?? null });
        test = 'failed';
        failure = smsTestFailure(error);
      }
      // The outcome is audited on its own, so a text the provider accepted stays recorded even if the save then conflicts.
      await scope(context.gymId, tx => writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: userId,
        action: 'integrations.sms_tested', targetType: 'gym', targetId: context.gymId, after: { test }, occurredAt: clock.now() }));
      if (test === 'failed') return failure ? { test, failure } : { test };
      await update(context, gym, config);
      return { test };
    },
    async remove(context: MutationContext, revision: number) {
      options.assertChangeable(); options.userOf(context);
      await update(context, await options.assertCurrent(context.gymId, revision), null);
    },
  };
}
