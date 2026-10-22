// SPDX-License-Identifier: AGPL-3.0-only
export interface AuthConfig {
  readonly secret: string;
  readonly tenancy: 'single' | 'multi';
  readonly passwordEnabled: boolean;
  readonly smtpConfigured: boolean;
  readonly production: boolean;
}
export function authConfig(env: NodeJS.ProcessEnv = process.env, smtpConfigured = Boolean(env.SMTP_HOST)): AuthConfig {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_SECRET must contain at least 32 characters');
  const tenancy = env.TENANCY ?? 'single';
  if (tenancy !== 'single' && tenancy !== 'multi') throw new Error('Invalid TENANCY');
  const mode = env.AUTH_PASSWORD_LOGIN ?? 'auto';
  if (!['auto', 'on', 'off'].includes(mode)) throw new Error('Invalid AUTH_PASSWORD_LOGIN');
  if (tenancy === 'multi' && mode !== 'off') throw new Error('TENANCY=multi requires AUTH_PASSWORD_LOGIN=off');
  if (tenancy === 'multi' && !smtpConfigured) throw new Error('TENANCY=multi requires SMTP');
  return { secret, tenancy, passwordEnabled: mode === 'on' || (mode === 'auto' && !smtpConfigured), smtpConfigured, production: env.NODE_ENV === 'production' };
}
