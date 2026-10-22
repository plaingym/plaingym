// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { SmtpEmail, type SmtpConfig } from '../email/index.js';
import { renderAuthLink } from '../../emails/staff/auth.js';

/** Sends each login link through the issuing gym's SMTP settings (its own, or the install's). */
export function createAuthEmailSender(smtpFor: (gymId: string) => Promise<SmtpConfig | null>) {
  const t = createTranslator(locales.en ?? {});
  return async (input: { email: string; url: string; gymId: string }) => {
    const config = await smtpFor(input.gymId);
    if (!config) throw new Error('Login email is not configured for this gym');
    const result = await new SmtpEmail(config).sendEmail({ to: input.email, ...renderAuthLink(input.url, t) });
    if (result.status !== 'sent') throw new Error('Login email was not delivered');
  };
}
