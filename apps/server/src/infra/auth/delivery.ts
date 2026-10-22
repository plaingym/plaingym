// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { SmtpEmail } from '../email/index.js';
import { renderAuthLink } from '../../emails/staff/auth.js';

export function createAuthEmailSender(env: NodeJS.ProcessEnv = process.env) {
  const security = env.SMTP_SECURITY ?? 'starttls';
  if (!['starttls', 'tls', 'plain'].includes(security)) throw new Error('Invalid SMTP security');
  const email = new SmtpEmail({
    host: env.SMTP_HOST ?? '', port: Number(env.SMTP_PORT ?? 587), from: env.SMTP_FROM ?? '',
    security: security as 'starttls' | 'tls' | 'plain',
    ...(env.SMTP_USER || env.SMTP_PASS ? { auth: { user: env.SMTP_USER ?? '', pass: env.SMTP_PASS ?? '' } } : {}),
  });
  const t = createTranslator(locales.en ?? {});
  return async (input: { email: string; url: string; gymId: string }) => {
    const result = await email.sendEmail({ to: input.email, ...renderAuthLink(input.url, t) });
    if (result.status !== 'sent') throw new Error('Login email was not delivered');
  };
}
