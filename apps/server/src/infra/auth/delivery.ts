// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { commandDigest, createEmailDeliveries, SmtpEmail, type Email, type EmailDeliveries, type SmtpConfig } from '../email/index.js';
import { renderAuthLink } from '../../emails/staff/auth.js';

/**
 * Sends each login link through the issuing gym's SMTP settings (its own, or the install's). The key names the link
 * itself, whose token Better Auth creates for one request, so asking again gets a new link and a new email, and only
 * sending the same link twice is refused. The URL is hashed: the table is kept for good and a key never holds a credential.
 */
export function createAuthEmailSender(smtpFor: (gymId: string) => Promise<SmtpConfig | null>,
  deliveries: EmailDeliveries = createEmailDeliveries(), transport: (config: SmtpConfig) => Email = config => new SmtpEmail(config)) {
  const t = createTranslator(locales.en ?? {});
  return async (input: { email: string; url: string; gymId: string }) => {
    const config = await smtpFor(input.gymId);
    if (!config) throw new Error('Login email is not configured for this gym');
    const result = await deliveries.send(input.gymId, 'auth.login_link:' + commandDigest([input.url]), transport(config),
      { to: input.email, ...renderAuthLink(input.url, t) });
    if (result.status === 'suppressed') throw new Error('Login email was not delivered');
  };
}
