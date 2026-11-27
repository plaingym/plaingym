// SPDX-License-Identifier: AGPL-3.0-only
import { configureAccountLimitKey } from './account-limit-key.js';

export interface AuthConfig {
  readonly secret: string;
  readonly tenancy: 'single' | 'multi';
  /** Install-level values from the environment; a gym's own SMTP settings refine them per gym. */
  readonly passwordEnabled: boolean;
  readonly smtpConfigured: boolean;
  readonly passwordMode?: 'auto' | 'on' | 'off';
  readonly production: boolean;
}
/** `auto` enables password login only for a gym that has no SMTP, its own or the install's. */
export function passwordLogin(config: AuthConfig, smtpConfigured: boolean): boolean {
  if (!config.passwordMode) return config.passwordEnabled;
  return config.passwordMode === 'on' || (config.passwordMode === 'auto' && !smtpConfigured);
}
export function authConfig(env: NodeJS.ProcessEnv = process.env, smtpConfigured = Boolean(env.SMTP_HOST)): AuthConfig {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_SECRET must contain at least 32 characters');
  configureAccountLimitKey(secret);
  const tenancy = env.TENANCY ?? 'single';
  if (tenancy !== 'single' && tenancy !== 'multi') {
    throw new Error(`TENANCY must be single or multi (got "${tenancy.slice(0, 40)}")`);
  }
  const mode = (env.AUTH_PASSWORD_LOGIN ?? '').trim().toLowerCase() || 'auto';
  if (!['auto', 'on', 'off'].includes(mode)) {
    throw new Error(`AUTH_PASSWORD_LOGIN must be auto, on or off (got "${env.AUTH_PASSWORD_LOGIN?.slice(0, 40)}")`);
  }
  if (tenancy === 'multi' && mode !== 'off') throw new Error('TENANCY=multi requires AUTH_PASSWORD_LOGIN=off');
  if (tenancy === 'multi' && !smtpConfigured) throw new Error('TENANCY=multi requires SMTP');
  return { secret, tenancy, passwordEnabled: mode === 'on' || (mode === 'auto' && !smtpConfigured), smtpConfigured,
    passwordMode: mode as 'auto' | 'on' | 'off', production: env.NODE_ENV === 'production' };
}
