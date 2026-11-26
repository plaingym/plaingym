// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, gyms } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { SmtpTestFailure } from '@plaingym/shared/contracts';
import { SmtpEmail, type EmailMessage, type SmtpConfig } from '../../infra/email/index.js';
import { smtpTestFailure } from '../../infra/email/failure.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { tenancyMode } from '../../core/tenancy.js';
import { readStoredSecret } from './unreadable-secret.js';
import { createEmailStatusRecorder, readSettingsMark } from './email-status.js';

/** The gym's own sending service, stored encrypted in `gyms.smtp_config_encrypted`. */
export const storedSmtpSchema = z.strictObject({
  host: z.string().trim().min(1), port: z.int().min(1).max(65535),
  security: z.enum(['starttls', 'tls', 'plain']), from: z.email(),
  username: z.string().min(1), password: z.string().min(1),
});
// A newer release may store more keys. This one ignores them, and a save replaces the whole value from the form.
export const readSmtpSchema = z.object(storedSmtpSchema.shape);
export type StoredSmtpConfig = z.infer<typeof storedSmtpSchema>;

export function encryptSmtpConfig(key: Buffer, gymId: string, config: StoredSmtpConfig): string {
  return encryptSecret(key, { secretClass: 'smtp_config', owner: gymId }, JSON.stringify(storedSmtpSchema.parse(config)));
}
function fromStored(config: StoredSmtpConfig, publicHostOnly = false): SmtpConfig {
  return { host: config.host, port: config.port, security: config.security, from: config.from,
    auth: { user: config.username, pass: config.password }, ...(publicHostOnly ? { publicHostOnly } : {}) };
}
/** Submitted settings (setup and Settings → Email) in their stored form: `secure` is implicit TLS, otherwise STARTTLS. */
export function storedSmtpFromRequest(input: { host: string; port: number; secure: boolean; username: string; password: string; from: string }): StoredSmtpConfig {
  return { host: input.host, port: input.port, security: input.secure ? 'tls' : 'starttls', username: input.username, password: input.password, from: input.from };
}
export type SendSmtpTest = (config: SmtpConfig, message: EmailMessage) => Promise<void>;

// The classifier lives with the email module, which the sign-in page and the send-status record also use.
export { smtpTestFailure };

/**
 * Sends `message` outside any transaction. Returns null on acceptance or a safe failure class. The original error
 * is never raised or logged. `publicHostOnly` is for a server a tenant named on a multi-gym install (`SmtpConfig`).
 */
export async function sendSmtpTest(config: StoredSmtpConfig, message: EmailMessage, send?: SendSmtpTest, publicHostOnly = false): Promise<SmtpTestFailure | null> {
  const smtp = fromStored(config, publicHostOnly);
  try {
    if (send) await send(smtp, message);
    else { const email = new SmtpEmail(smtp); try { await email.verifyTestSend(message); } finally { email.close(); } }
    return null;
  } catch (error) { return smtpTestFailure(error, { port: config.port, security: config.security }); }
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
  /** Reads the gym value once, including whether a stored value could not be read. */
  status(gymId: string): Promise<{ source: 'gym' | 'install' | null; unreadable: boolean }>;
  /**
   * The gym's own SMTP settings when saved, otherwise the install's, otherwise null. Either carries a `report` that
   * records the gym's email state from each send (`email-status.ts`).
   */
  config(gymId: string): Promise<SmtpConfig | null>;
  configured(gymId: string): Promise<boolean>;
}
export function createSmtpResolver(options: { key: Buffer; env?: NodeJS.ProcessEnv; scope?: typeof forGym; clock?: Clock }): SmtpResolver {
  const scope = options.scope ?? forGym, fallback = smtpFromEnvironment(options.env);
  const recorder = createEmailStatusRecorder({ scope, ...(options.clock ? { clock: options.clock } : {}) });
  // On a multi-gym install a gym's own server is a tenant's choice; the install's own never is.
  const tenantHosts = tenancyMode((options.env ?? process.env).TENANCY) === 'multi';
  const storedConfig = (gymId: string) => scope(gymId, async (tx) => (await tx.select({ smtp: gyms.smtpConfig }).from(gyms).where(eq(gyms.id, gymId)))[0]?.smtp);
  function readOwnConfig(gymId: string, stored: string | null | undefined) {
    return readStoredSecret(options.key, 'smtp_config', gymId, stored ?? null, () =>
      readSmtpSchema.parse(JSON.parse(decryptSecret(options.key, { secretClass: 'smtp_config', owner: gymId }, stored!))));
  }
  async function config(gymId: string): Promise<SmtpConfig | null> {
    // Read the settings mark before the stored SMTP value so a concurrent save makes the report skip instead of recording a stale result.
    const { mark, stored } = await scope(gymId, async (tx) => {
      const mark = await readSettingsMark(tx, gymId);
      const [row] = await tx.select({ smtp: gyms.smtpConfig }).from(gyms).where(eq(gyms.id, gymId));
      return { mark, stored: row?.smtp };
    });
    const own = readOwnConfig(gymId, stored);
    const resolved = own ? fromStored(own, tenantHosts) : fallback;
    return resolved && { ...resolved, report: recorder(gymId, { port: resolved.port, security: resolved.security ?? 'starttls', source: own ? 'gym' : 'install' }, mark) };
  }
  return { config, async status(gymId) {
    const stored = await storedConfig(gymId);
    const own = readOwnConfig(gymId, stored);
    return { source: own ? 'gym' : fallback ? 'install' : null, unreadable: !!stored && !own };
  }, async configured(gymId) { return (await config(gymId)) !== null; } };
}
