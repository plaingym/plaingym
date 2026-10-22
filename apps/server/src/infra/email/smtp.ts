// SPDX-License-Identifier: AGPL-3.0-only
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Email, EmailMessage, EmailResult } from './index.js';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** STARTTLS is required by default; plain is intended for local capture servers. */
  readonly security?: 'starttls' | 'tls' | 'plain';
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly from: string;
  readonly replyTo?: string;
}

function header(value: string, name: string): void {
  if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error(`Invalid email ${name}`);
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

/** SMTP for staff/security mail; use MemberEmail for member-targeted notifications. */
export class SmtpEmail implements Email {
  readonly #transport: Transporter<SMTPTransport.SentMessageInfo>;
  readonly #from: string;
  readonly #replyTo: string | undefined;

  constructor(config: SmtpConfig) {
    this.#transport = nodemailer.createTransport(smtpOptions(config));
    this.#from = config.from;
    this.#replyTo = config.replyTo;
  }

  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    assertNoTransaction('email.sendEmail');
    header(message.to, 'to');
    header(message.subject, 'subject');
    const replyTo = message.replyTo ?? this.#replyTo;
    if (replyTo !== undefined) header(replyTo, 'replyTo');
    const result = await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
    if (!result.accepted.length || result.rejected.length) throw new Error('SMTP recipient rejected');
    return { status: 'sent', messageId: result.messageId };
  }

  /** Connect, negotiate TLS and authenticate without delivering a message. */
  async verifyConnection(): Promise<void> {
    assertNoTransaction('email.verifyConnection');
    await this.#transport.verify();
  }

  /** Setup supplies translated content and an explicitly chosen test recipient. */
  async verifyTestSend(message: EmailMessage): Promise<EmailResult> {
    assertNoTransaction('email.verifyTestSend');
    await this.verifyConnection();
    return this.sendEmail(message);
  }

  close(): void {
    this.#transport.close();
  }
}
