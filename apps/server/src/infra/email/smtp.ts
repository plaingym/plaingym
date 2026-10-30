// SPDX-License-Identifier: AGPL-3.0-only
import type { Readable } from 'node:stream';
import nodemailer, { type Transport, type Transporter } from 'nodemailer';
import SMTPConnection from 'nodemailer/lib/smtp-connection/index.js';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { DeliveryError, type Email, type EmailMessage, type EmailResult } from './index.js';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** STARTTLS is required by default; plain is intended for local capture servers. */
  readonly security?: 'starttls' | 'tls' | 'plain';
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly from: string;
  readonly replyTo?: string;
}

const invalidHeader = (value: string) => !value.trim() || /[\r\n\0]/.test(value);
function header(value: string, name: string): void {
  if (invalidHeader(value)) throw new Error(`Invalid email ${name}`);
}

export function smtpOptions(config: SmtpConfig): SMTPTransport.Options {
  header(config.host, 'host');
  header(config.from, 'from');
  if (config.replyTo !== undefined) header(config.replyTo, 'replyTo');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error('Invalid SMTP port');
  const security = config.security ?? 'starttls';
  if (!['starttls', 'tls', 'plain'].includes(security)) throw new Error('Invalid SMTP security');
  if (config.auth && (!config.auth.user || !config.auth.pass)) throw new Error('Incomplete SMTP credentials');
  return {
    host: config.host,
    port: config.port,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'plain',
    ...(config.auth ? { auth: { ...config.auth } } : {}),
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}

type Stage = 'connect' | 'login' | 'send';
interface SentInfo { messageId: string; accepted: string[]; rejected: string[] }

/**
 * Nodemailer reports a lost socket or timeout as `CONN` in every phase, including after the message body,
 * so its error alone cannot prove a non-send. The stage this session reached can: nothing is handed over
 * before MAIL FROM, which only the send stage issues.
 */
function classify(stage: Stage, error: SMTPConnection.SMTPError): DeliveryError {
  if (stage === 'connect') return new DeliveryError('not_accepted', 'SMTP connection failed', { cause: error });
  if (stage === 'login') return new DeliveryError('not_accepted', 'SMTP authentication failed', { cause: error });
  // Refused sender, every recipient refused, refused DATA command, or a local check before MAIL FROM.
  if (error.code === 'EENVELOPE' || error.code === 'EREQUIRETLS' || (error.code === 'EMESSAGE' && error.command !== 'DATA'))
    return new DeliveryError('not_accepted', 'SMTP server refused the message envelope', { cause: error });
  // A 4xx/5xx reply to the end of the body: the server did not take responsibility for it (RFC 5321 §4.1.1.4).
  if (error.code === 'EMESSAGE' && error.command === 'DATA' && (error.responseCode ?? 0) >= 400)
    return new DeliveryError('not_accepted', 'SMTP server refused the message', { cause: error });
  // Socket loss and timeouts once the envelope is under way: the server may already hold the message.
  return new DeliveryError('unknown', 'SMTP delivery outcome is unknown', { cause: error });
}

interface SessionConfig {
  readonly options: SMTPConnection.Options;
  readonly auth: SmtpConfig['auth'];
  /** Sessions still open, so close() can end them. */
  readonly open: Set<SMTPConnection>;
}

/** One SMTP session per call; without a message it verifies the connection and credentials only. */
function session(config: SessionConfig, message?: { envelope: SMTPConnection.Envelope; body: Readable }):
  Promise<SMTPConnection.SentMessageInfo | undefined> {
  return new Promise((resolve, reject) => {
    const connection = new SMTPConnection(config.options), auth = config.auth;
    let stage: Stage = 'connect', settled = false;
    config.open.add(connection);
    const fail = (error: SMTPConnection.SMTPError) => {
      if (settled) return;
      settled = true;
      config.open.delete(connection);
      connection.close();
      reject(classify(stage, error));
    };
    const finish = (info?: SMTPConnection.SentMessageInfo) => {
      if (settled) return;
      settled = true;
      config.open.delete(connection);
      connection.quit();
      resolve(info);
    };
    // Errors after the outcome (for example while quitting) are ignored rather than left unhandled.
    connection.on('error', fail);
    // Some closes end the session without an error; settle rather than wait forever.
    connection.once('end', () => fail(Object.assign(new Error('SMTP connection ended'), { code: 'ECONNECTION' })));
    connection.connect((error) => {
      if (error) return fail(error);
      const deliver = () => {
        if (!message) return finish();
        stage = 'send';
        connection.send(message.envelope, message.body, (error, info) => error ? fail(error) : finish(info));
      };
      // As Nodemailer's SMTP transport does, authenticate only when the server offers AUTH.
      if (!auth || !(connection as SMTPConnection & { allowsAuth?: boolean }).allowsAuth) return deliver();
      stage = 'login';
      connection.login({ credentials: { user: auth.user, pass: auth.pass } }, (error) => error ? fail(error) : deliver());
    });
  });
}

/** A Nodemailer transport plugin: Nodemailer composes the message, this session delivers it. */
function smtpTransport(config: SessionConfig): Transport<SentInfo> {
  return {
    name: 'SMTP',
    version: '1',
    send(mail, callback) {
      const envelope = mail.message.getEnvelope(), messageId = mail.message.messageId();
      session(config, { envelope, body: mail.message.createReadStream() }).then(
        (info) => callback(null, { messageId, accepted: (info?.accepted ?? []).map(String), rejected: (info?.rejected ?? []).map(String) }),
        (error: Error) => callback(error, undefined as never));
    },
  };
}

/** SMTP for staff/security mail; use MemberEmail for member-targeted notifications. */
export class SmtpEmail implements Email {
  readonly #transport: Transporter<SentInfo>;
  readonly #session: SessionConfig;
  readonly #from: string;
  readonly #replyTo: string | undefined;

  constructor(config: SmtpConfig) {
    const { disableFileAccess, disableUrlAccess, ...options } = smtpOptions(config);
    // Credentials go to login() only; the connection options never hold them.
    delete options.auth;
    this.#session = { options: options as SMTPConnection.Options, auth: config.auth, open: new Set() };
    // A transport plugin receives the access restrictions through the message defaults.
    this.#transport = nodemailer.createTransport(smtpTransport(this.#session), { disableFileAccess, disableUrlAccess });
    this.#from = config.from;
    this.#replyTo = config.replyTo;
  }

  /** Throws DeliveryError: `not_accepted` only when no recipient can have received the message. */
  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    assertNoTransaction('email.sendEmail');
    const replyTo = message.replyTo ?? this.#replyTo;
    for (const [name, value] of [['to', message.to], ['subject', message.subject], ['replyTo', replyTo]] as const)
      if (value !== undefined && invalidHeader(value)) throw new DeliveryError('not_accepted', `Invalid email ${name}`);
    let result: SentInfo;
    try {
      result = await this.#transport.sendMail({
        from: this.#from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(replyTo !== undefined ? { replyTo } : {}),
      });
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      // Only composition fails outside the transport, before any connection is opened.
      throw new DeliveryError('not_accepted', 'Email message could not be composed', { cause: error });
    }
    if (!result.accepted.length || result.rejected.length)
      throw new DeliveryError('unknown', 'SMTP server accepted the message for only some recipients');
    return { status: 'sent', messageId: result.messageId };
  }

  /** Connect, negotiate TLS and authenticate without delivering a message. */
  async verifyConnection(): Promise<void> {
    assertNoTransaction('email.verifyConnection');
    await session(this.#session);
  }

  /** Setup supplies translated content and an explicitly chosen test recipient. */
  async verifyTestSend(message: EmailMessage): Promise<EmailResult> {
    assertNoTransaction('email.verifyTestSend');
    await this.verifyConnection();
    return this.sendEmail(message);
  }

  /** Ends any session still open; its pending send rejects as its stage classifies. */
  close(): void {
    for (const connection of this.#session.open) connection.close();
    this.#transport.close();
  }
}
