// SPDX-License-Identifier: AGPL-3.0-only
import type { SmtpTestFailure } from '@plaingym/shared/contracts';
import { deliveryAcceptance } from './index.js';
import { SmtpDeliveryError } from './smtp.js';

type SmtpSecurity = 'starttls' | 'tls' | 'plain';

const certificateErrorCodes = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);
const enhancedStatus = /^\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})\b/;

interface ErrorFacts {
  codes: Set<string>;
  responseCodes: Set<number>;
  enhancedStatuses: Set<string>;
  commands: Set<string>;
  /**
   * One object has both `ETIMEDOUT` and the `CONN` command: a timeout inside the SMTP session (Nodemailer reports its
   * connection, greeting and socket timeouts at `CONN`), not the host lookup's own timeout, which has no command.
   */
  connectTimeout: boolean;
}

/**
 * Read the transport codes, response numbers, leading enhanced status codes and commands of an error and its first
 * three causes. Reply text can contain sensitive values, so only these are read, each safely: a thrown value can itself
 * throw on property access, including a reply's getter, and that must not hide the transport code that names the cause.
 */
function readErrorFacts(error: unknown): ErrorFacts {
  const facts: ErrorFacts = { codes: new Set(), responseCodes: new Set(), enhancedStatuses: new Set(), commands: new Set(), connectTimeout: false };
  for (let depth = 0; depth < 4 && error !== null && typeof error === 'object'; depth++) {
    const current = error as Record<string, unknown>;
    const read = (key: string): unknown => { try { return current[key]; } catch { return undefined; } };
    const code = read('code'), originalCode = read('originalCode'), responseCode = read('responseCode'), response = read('response'), command = read('command');
    if (typeof code === 'string') facts.codes.add(code);
    if (typeof originalCode === 'string') facts.codes.add(originalCode);
    if (typeof responseCode === 'number') facts.responseCodes.add(responseCode);
    if (typeof command === 'string') facts.commands.add(command);
    if (code === 'ETIMEDOUT' && command === 'CONN') facts.connectTimeout = true;
    if (typeof response === 'string') {
      const status = enhancedStatus.exec(response)?.[1];
      if (status) facts.enhancedStatuses.add(status);
    }
    error = read('cause');
  }
  return facts;
}

/**
 * Use transport error codes, response numbers and the reply's leading enhanced status code only. Reply text can
 * contain sensitive values. `settings` lets a connect timeout or a refused connection on port 465 with STARTTLS name
 * the likely TLS mismatch.
 */
export function smtpTestFailure(error: unknown, settings?: { port: number; security: 'starttls' | 'tls' | 'plain' }): SmtpTestFailure {
  return classifyFacts(readErrorFacts(error), settings);
}

function classifyFacts(facts: ErrorFacts, settings?: { port: number; security: SmtpSecurity }): SmtpTestFailure {
  const { codes, responseCodes, enhancedStatuses, commands } = facts;
  for (const code of codes) {
    if (code === 'ETLS' || code === 'EPROTO' || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')
      || code.startsWith('CERT_') || code.startsWith('UNABLE_TO_') || certificateErrorCodes.has(code)) return 'tls';
  }
  if (codes.has('EAUTH')) return 'authentication';
  if (codes.has('EENVELOPE')) {
    if (responseCodes.has(530)) return 'authentication';
    // A policy refusal of the sender at MAIL FROM is the sender's problem, not the login's.
    if ((responseCodes.has(550) || responseCodes.has(554)) && (enhancedStatuses.has('5.7.0') || enhancedStatuses.has('5.7.1'))
      && commands.has('RCPT TO')) return 'authentication';
  }
  if (codes.has('EENVELOPE') || codes.has('EMESSAGE') || codes.has('EREQUIRETLS')) return 'sender_refused';
  if (settings?.port === 465 && settings.security === 'starttls' && (facts.connectTimeout || codes.has('ECONNECTION'))) return 'tls';
  return 'connection';
}

/**
 * A failed send that is the gym's sending service's fault, not the recipient's or the message's: no connection,
 * no secure connection, a refused login, or a refused sender address. Null for anything else, including a send
 * whose outcome is unknown and an error the SMTP transport did not make, so a caller never blames the service for a
 * message that may have gone out or for a failure that never reached SMTP.
 */
export function emailServiceFailure(error: unknown, settings?: { port: number; security: SmtpSecurity }): SmtpTestFailure | null {
  if (!(error instanceof SmtpDeliveryError) || deliveryAcceptance(error) !== 'not_accepted') return null;
  const facts = readErrorFacts(error);
  const failure = classifyFacts(facts, settings);
  if (failure === 'authentication') {
    // A recipient refused at RCPT TO with 550 or 554 is the recipient's address or policy, not the gym's login failing.
    const { codes, commands, responseCodes } = facts;
    if (codes.has('EENVELOPE') && !codes.has('EAUTH') && commands.has('RCPT TO')
      && (responseCodes.has(550) || responseCodes.has(554)) && !responseCodes.has(530)) return null;
    return failure;
  }
  if (failure === 'connection' || failure === 'tls') return failure;
  if (failure === 'sender_refused' && facts.commands.has('MAIL FROM')) return failure;
  return null;
}
