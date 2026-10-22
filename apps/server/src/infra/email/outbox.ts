// SPDX-License-Identifier: AGPL-3.0-only
import { emailOutbox, forGym, uuidv7, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Email, EmailMessage, EmailResult } from './index.js';

/** Demo transport: its only side effect is a gym-scoped outbox write. */
export class OutboxEmail implements Email {
  constructor(readonly gymId: string, readonly clock: Clock, private readonly scope: typeof forGym = forGym) {}
  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    assertNoTransaction('email.sendEmail');
    const id = uuidv7(this.clock.now().getTime()), now = this.clock.now();
    await this.scope(this.gymId, async (tx) => {
      await tx.insert(emailOutbox).values({ id, gymId: this.gymId, recipient: message.to, subject: message.subject,
        html: message.html, text: message.text, sentAt: now, createdAt: now });
      await writeAudit(tx, { gymId: this.gymId, actorKind: 'system', action: 'demo.email_captured', targetType: 'email_outbox', targetId: id, occurredAt: now });
    });
    return { status: 'sent', messageId: id };
  }
}
