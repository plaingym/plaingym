// SPDX-License-Identifier: AGPL-3.0-only
import { databaseCode, forGym, isConnectionError } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { createEmailDeliveries, DeliveryError, recipientDigest, SmtpEmail, type Email, type SmtpConfig } from '../../infra/email/index.js';
import { createSmtpResolver } from '../settings/smtp.js';
import { createSettingsService } from '../settings/settings.js';
import { renderAutoUpdateNotice } from '../../emails/health/auto-update.js';
import { describeAttempt, formatAutoUpdateTime, type AutoUpdateAttempt } from './auto-update.js';

export interface AutoUpdateNoticeOptions {
  env?: NodeJS.ProcessEnv;
  scope?: typeof forGym;
  clock?: Clock;
  owners?: (gymId: string) => Promise<string[]>;
  transport?: (config: SmtpConfig) => Email & { close?: () => void };
}
/** Retrying unchanged local settings or rendering cannot make this notice sendable. */
export class PermanentAutoUpdateNoticeError extends Error {}
class TemporaryAutoUpdateNoticeLookupError extends Error {}
async function lookup<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (isConnectionError(error) || ['40001', '40P01', '55P03', '57014', '53100', '53200'].includes(databaseCode(error) ?? '')) {
      throw new TemporaryAutoUpdateNoticeLookupError(error instanceof Error ? error.message : 'Automatic update notice lookup failed', { cause: error });
    }
    throw error;
  }
}
/** Only a definite non-send or a database failure that can clear warrants another hourly attempt. */
export function retryableAutoUpdateNoticeError(error: unknown): boolean {
  if (error instanceof DeliveryError) return error.acceptance === 'not_accepted';
  return error instanceof TemporaryAutoUpdateNoticeLookupError;
}
/** Called by the host's record command. A replay uses the same durable per-attempt, per-owner delivery key. */
export function createAutoUpdateNotices(options: AutoUpdateNoticeOptions = {}) {
  const env = options.env ?? process.env, scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return async (gymId: string, attempt: AutoUpdateAttempt): Promise<void> => {
    if (env.TENANCY === 'multi' || !['rolled_back', 'failed'].includes(attempt.result)) return;
    let smtp;
    try { smtp = createSmtpResolver({ key: parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? ''), env, scope }); }
    catch (error) { throw new PermanentAutoUpdateNoticeError('Automatic update notice settings are invalid', { cause: error }); }
    const config = await lookup(() => smtp.config(gymId));
    if (!config) return;
    const owners = options.owners ?? ((id: string) => createAccountService(authConfig(env)).staffEmails(id, ['owner']));
    const [recipients, gym] = await Promise.all([lookup(() => owners(gymId)), lookup(() => createSettingsService({ scope, clock }).get(gymId))]);
    let rendered;
    try {
      rendered = await renderAutoUpdateNotice({ gymName: gym.name, timezone: gym.timezone,
        time: formatAutoUpdateTime(attempt.attemptedAt, gym.timezone),
        message: describeAttempt(true, attempt, new Date(attempt.attemptedAt), { timezone: gym.timezone }).message });
    } catch (error) { throw new PermanentAutoUpdateNoticeError('Automatic update notice could not be rendered', { cause: error }); }
    const deliveries = createEmailDeliveries({ scope, clock }), email = options.transport?.(config) ?? new SmtpEmail(config);
    const errors: unknown[] = [];
    try {
      // Owners get separate messages; neither their addresses nor SMTP credentials reach an audit row.
      for (const to of new Set(recipients.map(address => address.trim().toLowerCase()))) {
        const key = `auto-update:${new Date(attempt.attemptedAt).toISOString()}:${attempt.toVersion}:${recipientDigest(to)}`;
        // One owner's failed send must not keep the notice from the others.
        try { await deliveries.send(gymId, key, email, { ...rendered, to }); } catch (error) { errors.push(error); }
      }
    } finally { email.close?.(); }
    // A definite non-send wins, so the host retries it; the delivery keys skip owners already sent to.
    if (errors.length) throw errors.find(retryableAutoUpdateNoticeError) ?? errors[0];
  };
}
