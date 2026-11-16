// SPDX-License-Identifier: AGPL-3.0-only
import { smsOutbox, forGym, uuidv7, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { DeliveryError, validateSms, type Sms, type SmsMessage, type SmsResult } from './index.js';

/** Demo transport: capture and audit commit together, without any provider access. */
export class OutboxSms implements Sms {
  constructor(readonly gymId: string, readonly clock: Clock, private readonly scope: typeof forGym = forGym) {}
  async verifyAccount(): Promise<void> { assertNoTransaction('sms.verifyAccount'); }
  async sendSms(message: SmsMessage): Promise<SmsResult> {
    assertNoTransaction('sms.sendSms');
    validateSms(message);
    const now = this.clock.now(), id = uuidv7(now.getTime());
    try {
      await this.scope(this.gymId, async tx => {
        await tx.insert(smsOutbox).values({ id, gymId: this.gymId, recipient: message.to, body: message.body, sentAt: now, createdAt: now });
        await writeAudit(tx, { gymId: this.gymId, actorKind: 'system', action: 'demo.sms_captured', targetType: 'sms_outbox', targetId: id, occurredAt: now });
      });
    } catch { throw new DeliveryError('not_accepted', 'SMS could not be captured'); }
    return { status: 'sent', messageId: id };
  }
}
