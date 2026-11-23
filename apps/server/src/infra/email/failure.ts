// SPDX-License-Identifier: AGPL-3.0-only
import type { SmtpTestFailure } from '@plaingym/shared/contracts';
import { deliveryAcceptance } from './index.js';

type SmtpSecurity = 'starttls' | 'tls' | 'plain';

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
 * A failed send that is the gym's sending service's fault, not the recipient's or the message's: no connection,
 * no secure connection, a refused login, or a refused sender address. Null for anything else, including a send
 * whose outcome is unknown, so a caller never blames the service for a message that may have gone out.
 */
export function emailServiceFailure(error: unknown, settings?: { port: number; security: SmtpSecurity }): SmtpTestFailure | null {
  if (deliveryAcceptance(error) !== 'not_accepted') return null;
  const failure = smtpTestFailure(error, settings);
  if (failure === 'connection' || failure === 'tls' || failure === 'authentication') return failure;
  if (failure === 'sender_refused' && refusedAt(error, 'MAIL FROM')) return failure;
  return null;
}
/** Whether the error or one of its first three causes is a reply to `command`, read as safely as `smtpTestFailure` reads. */
function refusedAt(error: unknown, command: string): boolean {
  for (let depth = 0; depth < 4 && error !== null && typeof error === 'object'; depth++) {
    const current = error as Record<string, unknown>;
    const read = (key: string): unknown => { try { return current[key]; } catch { return undefined; } };
    if (read('command') === command) return true;
    error = read('cause');
  }
  return false;
}
