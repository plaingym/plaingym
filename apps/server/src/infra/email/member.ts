// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, members } from '@plaingym/db';
import { eq } from 'drizzle-orm';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { DeliveryError, type Email, type EmailMessage, type EmailResult } from './index.js';

export type SuppressionReason = Extract<EmailResult, { status: 'suppressed' }>['reason'];
export interface EmailSuppression {
  readonly event: 'email.suppressed';
  readonly gymId: string;
  readonly memberId: string;
  readonly reason: SuppressionReason;
}
export interface MemberEmailOptions {
  readonly gymId: string;
  readonly memberId: string;
  readonly email: Email;
  readonly settings: GymSettingsAccessor;
  readonly logSuppression?: (event: EmailSuppression) => void;
  readonly forGym?: typeof forGym;
}

/** Bound member context preserves the frozen Email interface and prevents opt-out bypass. */
export class MemberEmail implements Email {
  readonly #options: MemberEmailOptions;
  constructor(options: MemberEmailOptions) {
    this.#options = { ...options };
  }

  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    assertNoTransaction('email.sendEmail');
    let reason: SuppressionReason | undefined;
    try { reason = await this.#check(message); }
    catch (error) {
      // Every check finishes before the transport is called, so a failure here proves nothing was sent.
      throw error instanceof DeliveryError ? error : new DeliveryError('not_accepted', 'Member email checks failed', { cause: error });
    }
    if (reason) return { status: 'suppressed', reason };
    // Both settings and member reads have committed before any network call.
    return this.#options.email.sendEmail(message);
  }

  async #check(message: EmailMessage): Promise<SuppressionReason | undefined> {
    const { gymId, memberId, settings } = this.#options;
    const gym = await settings.get(gymId);
    if (gym.gymId !== gymId) throw new DeliveryError('not_accepted', 'Email gym settings mismatch');
    const member = await (this.#options.forGym ?? forGym)(gymId, async (tx) => {
      const [row] = await tx.select({
        email: members.email,
        optOut: members.emailOptOut,
        deliverable: members.emailDeliverable,
      }).from(members).where(eq(members.id, memberId));
      return row;
    });
    if (!member) throw new DeliveryError('not_accepted', 'Email member not found');
    // A caller cannot use an unrelated, opted-in member to authorize another recipient.
    if (!member.email || member.email.trim().toLowerCase() !== message.to.trim().toLowerCase())
      throw new DeliveryError('not_accepted', 'Email recipient does not match member');
    const reason = !gym.memberEmailsEnabled ? 'disabled'
      : member.optOut ? 'opt_out' : !member.deliverable ? 'undeliverable' : undefined;
    if (reason) {
      const event: EmailSuppression = { event: 'email.suppressed', gymId, memberId, reason };
      (this.#options.logSuppression ?? ((entry) => console.info(entry)))(event);
    }
    return reason;
  }
}
