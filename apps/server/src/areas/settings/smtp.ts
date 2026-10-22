// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, gyms } from '@plaingym/db';
import type { SmtpConfig } from '../../infra/email/index.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';

/** The gym's own sending service, stored encrypted in `gyms.smtp_config_encrypted`. */
export const storedSmtpSchema = z.strictObject({
  host: z.string().trim().min(1), port: z.int().min(1).max(65535),
  security: z.enum(['starttls', 'tls', 'plain']), from: z.email(),
  username: z.string().min(1), password: z.string().min(1),
});
export type StoredSmtpConfig = z.infer<typeof storedSmtpSchema>;

export function encryptSmtpConfig(key: Buffer, config: StoredSmtpConfig): string {
  return encryptSecret(key, 'smtp_config', JSON.stringify(storedSmtpSchema.parse(config)));
}
function fromStored(config: StoredSmtpConfig): SmtpConfig {
  return { host: config.host, port: config.port, security: config.security, from: config.from,
    auth: { user: config.username, pass: config.password } };
}

/** Install-wide fallback from `SMTP_*`, used by any gym without its own sending service. */
export function smtpFromEnvironment(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  if (!env.SMTP_HOST) return null;
  const security = env.SMTP_SECURITY ?? 'starttls';
  if (security !== 'starttls' && security !== 'tls' && security !== 'plain') throw new Error('Invalid SMTP_SECURITY');
  return { host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), from: env.SMTP_FROM ?? '', security,
    ...(env.SMTP_USER || env.SMTP_PASS ? { auth: { user: env.SMTP_USER ?? '', pass: env.SMTP_PASS ?? '' } } : {}) };
}

export interface SmtpResolver {
  /** The gym's own SMTP settings when saved, otherwise the install's, otherwise null. */
  config(gymId: string): Promise<SmtpConfig | null>;
  configured(gymId: string): Promise<boolean>;
  source(gymId: string): Promise<'gym' | 'install' | null>;
}
export function createSmtpResolver(options: { key: Buffer; env?: NodeJS.ProcessEnv; scope?: typeof forGym }): SmtpResolver {
  const scope = options.scope ?? forGym, fallback = smtpFromEnvironment(options.env);
  const storedConfig = (gymId: string) => scope(gymId, async (tx) => (await tx.select({ smtp: gyms.smtpConfig }).from(gyms).where(eq(gyms.id, gymId)))[0]?.smtp);
  async function config(gymId: string): Promise<SmtpConfig | null> {
    const stored = await storedConfig(gymId);
    if (!stored) return fallback;
    return fromStored(storedSmtpSchema.parse(JSON.parse(decryptSecret(options.key, 'smtp_config', stored))));
  }
  return { config, async configured(gymId) { return (await config(gymId)) !== null; },
    async source(gymId) { return await storedConfig(gymId) ? 'gym' : fallback ? 'install' : null; } };
}
