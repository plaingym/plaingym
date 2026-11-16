// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, gyms } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TwilioSms, OutboxSms, type Sms } from '../../infra/sms/index.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { clock as systemClock } from '../../core/clock.js';
import { readStoredSecret } from './unreadable-secret.js';

const sid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9a-fA-F]{32}$`));
export const twilioBaseUrl = 'https://api.twilio.com';
const baseSchema = z.url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
export const storedSmsSchema = z.strictObject({
  accountSid: sid('AC'),
  auth: z.union([z.strictObject({ token: z.string().min(1).max(1024) }), z.strictObject({ apiKey: sid('SK'), secret: z.string().min(1).max(1024) })]),
  sender: z.union([z.strictObject({ from: z.string().regex(/^[+][1-9][0-9]{1,14}$/) }), z.strictObject({ messagingServiceSid: sid('MG') })]),
  baseUrl: baseSchema.optional(),
});
export type StoredSmsConfig = z.infer<typeof storedSmsSchema>;
// Ignore additional top-level keys written by a newer release.
const readSmsSchema = z.object(storedSmsSchema.shape);
export function encryptSmsConfig(key: Buffer, gymId: string, config: StoredSmsConfig): string {
  return encryptSecret(key, { secretClass: 'sms_config', owner: gymId }, JSON.stringify(storedSmsSchema.parse(config)));
}
export interface ResolvedSms { readonly gymId: string; readonly name: string; readonly sms: Sms }
export interface SmsResolver {
  resolve(gymId: string): Promise<ResolvedSms | null>;
  status(gymId: string): Promise<{ source: 'gym' | 'demo' | null; unreadable: boolean }>;
  configured(gymId: string): Promise<boolean>;
}
export function createSmsResolver(options: {
  key: Buffer; tenancy: 'single' | 'multi'; scope?: typeof forGym; demo?: boolean; clock?: Clock; fetch?: typeof fetch;
}): SmsResolver {
  const scope = options.scope ?? forGym;
  async function read(gymId: string) {
    // The demo projection deliberately never reads credentials.
    if (options.demo) {
      const [gym] = await scope(gymId, tx => tx.select({ id: gyms.id, name: gyms.name }).from(gyms).where(eq(gyms.id, gymId)));
      return { gym, config: null, unreadable: false };
    }
    const [gym] = await scope(gymId, tx => tx.select({ id: gyms.id, name: gyms.name, secret: gyms.smsConfig }).from(gyms).where(eq(gyms.id, gymId)));
    const config = readStoredSecret(options.key, 'sms_config', gymId, gym?.secret ?? null, () => {
      const value = readSmsSchema.parse(JSON.parse(decryptSecret(options.key, { secretClass: 'sms_config', owner: gymId }, gym!.secret!)));
      if (options.tenancy === 'multi' && new URL(value.baseUrl ?? twilioBaseUrl).href !== twilioBaseUrl + '/') throw new Error('SMS provider base is unavailable');
      return value;
    });
    return { gym, config, unreadable: !!gym?.secret && !config };
  }
  async function resolve(gymId: string): Promise<ResolvedSms | null> {
    assertNoTransaction('sms.resolve');
    const { gym, config } = await read(gymId);
    if (!gym) return null;
    if (options.demo) return { gymId, name: gym.name, sms: new OutboxSms(gymId, options.clock ?? systemClock, scope) };
    return config ? { gymId, name: gym.name, sms: new TwilioSms(config, options.fetch) } : null;
  }
  return { resolve, async configured(gymId) { return (await resolve(gymId)) !== null; }, async status(gymId) {
    const { gym, config, unreadable } = await read(gymId);
    return { source: options.demo && gym ? 'demo' : config ? 'gym' : null, unreadable };
  } };
}
