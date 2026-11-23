// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, gyms } from '@plaingym/db';
import type { SmtpTestFailure } from '@plaingym/shared/contracts';
import { SmtpEmail, type EmailMessage, type SmtpConfig } from '../../infra/email/index.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { tenancyMode } from '../../core/tenancy.js';
import { readStoredSecret } from './unreadable-secret.js';

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

const certificateErrorCodes = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);
const enhancedStatus = /^\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})\b/;
/**
 * Use transport error codes, response numbers and the reply's leading enhanced status code only. Reply text can
 * contain sensitive values. `settings` lets a timeout on port 465 with STARTTLS name the likely TLS mismatch.
 */
export function smtpTestFailure(error: unknown, settings?: { port: number; security: 'starttls' | 'tls' | 'plain' }): SmtpTestFailure {
  const codes = new Set<string>(), responseCodes = new Set<number>(), enhancedStatuses = new Set<string>();
  for (let depth = 0; depth < 4 && error !== null && typeof error === 'object'; depth++) {
    const current = error as Record<string, unknown>;
    // A thrown value can itself throw on property access, including a reply's getter. Read each safely so a reply
    // getter cannot hide the transport code that already names the cause.
    const read = (key: string): unknown => { try { return current[key]; } catch { return undefined; } };
    const code = read('code'), originalCode = read('originalCode'), responseCode = read('responseCode'), response = read('response');
    if (typeof code === 'string') codes.add(code);
    if (typeof originalCode === 'string') codes.add(originalCode);
    if (typeof responseCode === 'number') responseCodes.add(responseCode);
    if (typeof response === 'string') {
      const status = enhancedStatus.exec(response)?.[1];
      if (status) enhancedStatuses.add(status);
    }
    error = read('cause');
  }
  for (const code of codes) {
    if (code === 'ETLS' || code === 'EPROTO' || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')
      || code.startsWith('CERT_') || code.startsWith('UNABLE_TO_') || certificateErrorCodes.has(code)) return 'tls';
  }
  if (codes.has('EAUTH')) return 'authentication';
  if (codes.has('EENVELOPE') && (responseCodes.has(530) || ((responseCodes.has(550) || responseCodes.has(554))
    && (enhancedStatuses.has('5.7.0') || enhancedStatuses.has('5.7.1'))))) return 'authentication';
  if (codes.has('EENVELOPE') || codes.has('EMESSAGE') || codes.has('EREQUIRETLS')) return 'sender_refused';
  if (settings?.port === 465 && settings.security === 'starttls' && (codes.has('ETIMEDOUT') || codes.has('ECONNECTION'))) return 'tls';
  return 'connection';
}

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
  /** The gym's own SMTP settings when saved, otherwise the install's, otherwise null. */
  config(gymId: string): Promise<SmtpConfig | null>;
  configured(gymId: string): Promise<boolean>;
}
export function createSmtpResolver(options: { key: Buffer; env?: NodeJS.ProcessEnv; scope?: typeof forGym }): SmtpResolver {
  const scope = options.scope ?? forGym, fallback = smtpFromEnvironment(options.env);
  // On a multi-gym install a gym's own server is a tenant's choice; the install's own never is.
  const tenantHosts = tenancyMode((options.env ?? process.env).TENANCY) === 'multi';
  const storedConfig = (gymId: string) => scope(gymId, async (tx) => (await tx.select({ smtp: gyms.smtpConfig }).from(gyms).where(eq(gyms.id, gymId)))[0]?.smtp);
  function readOwnConfig(gymId: string, stored: string | null | undefined) {
    return readStoredSecret(options.key, 'smtp_config', gymId, stored ?? null, () =>
      readSmtpSchema.parse(JSON.parse(decryptSecret(options.key, { secretClass: 'smtp_config', owner: gymId }, stored!))));
  }
  async function ownConfig(gymId: string) {
    return readOwnConfig(gymId, await storedConfig(gymId));
  }
  async function config(gymId: string): Promise<SmtpConfig | null> {
    const own = await ownConfig(gymId);
    return own ? fromStored(own, tenantHosts) : fallback;
  }
  return { config, async status(gymId) {
    const stored = await storedConfig(gymId);
    const own = readOwnConfig(gymId, stored);
    return { source: own ? 'gym' : fallback ? 'install' : null, unreadable: !!stored && !own };
  }, async configured(gymId) { return (await config(gymId)) !== null; } };
}
