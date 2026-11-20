// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, gyms } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { smsSidSchema as sid, smsBaseUrlSchema } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TwilioSms, OutboxSms, type Sms } from '../../infra/sms/index.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { clock as systemClock } from '../../core/clock.js';
import { readStoredSecret } from './unreadable-secret.js';

export const twilioBaseUrl = 'https://api.twilio.com';
/** One declaration per auth and sender variant: the strict write schema and the loose read schema both use every entry. */
const authVariants = [
  z.strictObject({ token: z.string().min(1).max(1024) }),
  z.strictObject({ apiKey: sid('SK'), secret: z.string().min(1).max(1024) }),
];
const senderVariants = [
  z.strictObject({ from: z.string().regex(/^[+][1-9][0-9]{1,14}$/) }),
  z.strictObject({ messagingServiceSid: sid('MG') }),
];
export const storedSmsSchema = z.strictObject({
  accountSid: sid('AC'),
  auth: z.union(authVariants),
  sender: z.union(senderVariants),
  baseUrl: smsBaseUrlSchema.optional(),
});
export type StoredSmsConfig = z.infer<typeof storedSmsSchema>;
// Ignore additional keys written by a newer release, including inside auth and sender. The loose variants keep the
// write variants' types; TypeScript loses them through the mapped union, so they are asserted back.
const readSmsSchema = z.object({ ...storedSmsSchema.shape,
  auth: z.union(authVariants.map(variant => z.object(variant.shape))) as unknown as typeof storedSmsSchema.shape.auth,
  sender: z.union(senderVariants.map(variant => z.object(variant.shape))) as unknown as typeof storedSmsSchema.shape.sender,
});
export function readSmsConfig(key: Buffer, tenancy: 'single' | 'multi', gymId: string, stored: string | null): StoredSmsConfig | null {
  return readStoredSecret(key, 'sms_config', gymId, stored, () => {
    const config = readSmsSchema.parse(JSON.parse(decryptSecret(key, { secretClass: 'sms_config', owner: gymId }, stored!)));
    if (tenancy === 'multi' && new URL(config.baseUrl ?? twilioBaseUrl).href !== twilioBaseUrl + '/') throw new Error('SMS provider base is unavailable');
    return config;
  });
}
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
    const config = readSmsConfig(options.key, options.tenancy, gymId, gym?.secret ?? null);
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
