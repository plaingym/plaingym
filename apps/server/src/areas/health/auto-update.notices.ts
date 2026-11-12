// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { createEmailDeliveries, recipientDigest, SmtpEmail, type Email, type SmtpConfig } from '../../infra/email/index.js';
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
/** Called by the host's record command. A replay uses the same durable per-attempt, per-owner delivery key. */
export function createAutoUpdateNotices(options: AutoUpdateNoticeOptions = {}) {
  const env = options.env ?? process.env, scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return async (gymId: string, attempt: AutoUpdateAttempt): Promise<void> => {
    if (env.TENANCY === 'multi' || !['rolled_back', 'failed'].includes(attempt.result)) return;
    const smtp = createSmtpResolver({ key: parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? ''), env, scope });
    const config = await smtp.config(gymId);
    if (!config) return;
    const owners = options.owners ?? ((id: string) => createAccountService(authConfig(env)).staffEmails(id, ['owner']));
    const [recipients, gym] = await Promise.all([owners(gymId), createSettingsService({ scope, clock }).get(gymId)]);
    const rendered = await renderAutoUpdateNotice({ gymName: gym.name, timezone: gym.timezone,
      time: formatAutoUpdateTime(attempt.attemptedAt, gym.timezone),
      message: describeAttempt(true, attempt, new Date(attempt.attemptedAt), { timezone: gym.timezone }).message });
    const deliveries = createEmailDeliveries({ scope, clock }), email = options.transport?.(config) ?? new SmtpEmail(config);
    try {
      // Owners get separate messages; neither their addresses nor SMTP credentials reach an audit row.
      for (const to of new Set(recipients.map(address => address.trim().toLowerCase()))) {
        const key = `auto-update:${new Date(attempt.attemptedAt).toISOString()}:${attempt.toVersion}:${recipientDigest(to)}`;
        await deliveries.send(gymId, key, email, { ...rendered, to });
      }
    } finally { email.close?.(); }
  };
}
