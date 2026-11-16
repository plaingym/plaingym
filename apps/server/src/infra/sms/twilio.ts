// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { SmsDeliveryError, validateSms, type Sms, type SmsMessage, type SmsResult } from './index.js';

import { smsDeadlineMs } from './constants.js';
export interface TwilioConfig {
  readonly accountSid: string;
  readonly auth: { readonly token: string } | { readonly apiKey: string; readonly secret: string };
  readonly sender: { readonly from: string } | { readonly messagingServiceSid: string };
  readonly baseUrl?: string | undefined;
}
const preConnectCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
function failedBeforeConnect(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && typeof error.code === 'string' && preConnectCodes.has(error.code)) return true;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(failedBeforeConnect);
  return 'cause' in error && failedBeforeConnect(error.cause);
}
/** No redirects, retries or raw error causes: they can disclose credentials or recipient content. */
export class TwilioSms implements Sms {
  readonly #config: TwilioConfig;
  constructor(config: TwilioConfig, private readonly fetcher: typeof fetch = fetch) { this.#config = structuredClone(config); }
  async verifyAccount(): Promise<void> {
    assertNoTransaction('sms.verifyAccount');
    await this.#request('GET');
  }
  async sendSms(message: SmsMessage): Promise<SmsResult> {
    assertNoTransaction('sms.sendSms');
    validateSms(message);
    const sender = this.#config.sender;
    const form = new URLSearchParams({ To: message.to, Body: message.body,
      ...('from' in sender ? { From: sender.from } : { MessagingServiceSid: sender.messagingServiceSid }) });
    const result = await this.#request('POST', form);
    if (!result || typeof result !== 'object' || !('sid' in result) || typeof result.sid !== 'string' || !/^(SM|MM)[0-9a-f]{32}$/i.test(result.sid))
      throw new SmsDeliveryError('unknown');
    return { status: 'sent', messageId: result.sid };
  }
  async #request(method: 'GET' | 'POST', body?: URLSearchParams): Promise<unknown> {
    const { accountSid, auth } = this.#config;
    let url: URL;
    try {
      url = new URL(this.#config.baseUrl ?? 'https://api.twilio.com');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new Error();
      url.pathname = url.pathname.replace(/\/$/, '') + `/2010-04-01/Accounts/${accountSid}/Messages.json`;
      // Standard API keys cannot read Accounts. A bounded message listing checks authentication without sending.
      if (method === 'GET') url.searchParams.set('PageSize', '1');
    } catch { throw new SmsDeliveryError('not_accepted'); }
    const credentials = 'token' in auth ? `${accountSid}:${auth.token}` : `${auth.apiKey}:${auth.secret}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acceptance: 'not_accepted' | 'unknown' = 'unknown';
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetcher(url, { method, redirect: 'manual', signal: controller.signal,
            headers: { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
              ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, ...(body ? { body } : {}) });
          // Status alone proves rejection, even if reading the error payload fails or exceeds the deadline.
          if (response.status >= 400 && response.status < 500) acceptance = 'not_accepted';
          if (method === 'GET' && response.ok) { await response.body?.cancel(); return undefined; }
          const result: unknown = await response.json().catch(() => null);
          if (response.status >= 400 && response.status < 500) {
            const optedOut = result && typeof result === 'object' && 'code' in result && result.code === 21610;
            throw new SmsDeliveryError('not_accepted', optedOut ? 'recipient_opted_out' : 'provider_error');
          }
          if (!response.ok) throw new SmsDeliveryError('unknown');
          return result;
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SmsDeliveryError(acceptance)); }, smsDeadlineMs); }),
      ]);
    } catch (error) {
      if (error instanceof SmsDeliveryError) throw error;
      throw new SmsDeliveryError(failedBeforeConnect(error) ? 'not_accepted' : acceptance);
    } finally { clearTimeout(timer); }
  }
}
