// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { signedLinks, type forGym, uuidv7, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { deliveryAcceptance, type Email } from '../../infra/email/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { checkoutInProgress, deliveryBlocked, deliveryHistory } from './campaigns.attempts.js';
import { campaignRecipient } from './campaigns.model.js';
import { deliverSignedLink, validateSignedLinkDelivery, type SignedLinkDelivery } from './service.delivery.js';

/** Reissue the existing recipient credential; reminders never add recipients or extend their expiry. */
export async function deliverCampaignLink(options: { scope: typeof forGym; clock: Clock; delivery: SignedLinkDelivery },
  gymId: string, campaignId: string, linkId: string, occurrence: string) {
  const { scope, clock, delivery } = options;
  const gym = await createGymSettingsAccessor({ scope }).get(gymId);
  let prepared;
  try {
    prepared = await delivery.prepare(gymId);
    validateSignedLinkDelivery(prepared, gymId);
  } catch (error) {
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.delivery_cancelled',
      targetType: 'signed_link', targetId: linkId, after: { campaignId, occurrence }, occurredAt: clock.now() }));
    throw error; // No credential changed or SMTP attempted; configuration can recover on the job retry.
  }
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const reservationId = uuidv7(clock.now().getTime());
  const reservation = await scope(gymId, async tx => {
    const [row] = await tx.select().from(signedLinks).where(and(eq(signedLinks.id, linkId), eq(signedLinks.campaignId, campaignId))).for('update');
    if (!row || campaignRecipient(row, clock.now()).state !== 'pending') return;
    const history = await deliveryHistory(tx, gymId, [linkId]);
    if (checkoutInProgress(history, linkId, clock.now())) {
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.delivery_deferred',
        targetType: 'signed_link', targetId: linkId, after: { campaignId, occurrence }, occurredAt: clock.now() });
      return;
    }
    if (deliveryBlocked(history, linkId, occurrence, clock.now(), gym.timezone)) return;
    await tx.update(signedLinks).set({ tokenHash }).where(eq(signedLinks.id, linkId));
    await writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.delivery_reserved',
      targetType: 'signed_link', targetId: linkId, after: { campaignId, occurrence, reservation: reservationId }, occurredAt: clock.now() });
    return { link: campaignRecipient(row, clock.now()).link, previousHash: row.tokenHash };
  });
  if (!reservation) return;
  let outcome = 'cancelled', transportEntered = false, transportSuppressed = false, failure: unknown;
  // Observe the shared delivery's existing transport boundary. All sending and its last-moment
  // switch/recipient checks still live in service.delivery; no second outbound call site is added.
  const observed: Email = { sendEmail: new Proxy(prepared.email.sendEmail, {
    apply(send, _receiver, args) {
      transportEntered = true;
      return (Reflect.apply(send, prepared.email, args) as ReturnType<Email['sendEmail']>).then(result => {
        transportSuppressed = result.status !== 'sent';
        return result;
      });
    },
  }) };
  try {
    // A completion or revoke committed during preparation stops the queued send.
    const [current] = await scope(gymId, tx => tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)));
    if (current && current.tokenHash === tokenHash && campaignRecipient(current, clock.now()).state === 'pending') {
      await deliverSignedLink({ scope, context: { gymId, actor: { kind: 'system' } }, link: reservation.link, token,
        delivery: { ...prepared, email: observed } });
      outcome = 'sent';
    }
  } catch (error) {
    if (!transportEntered || transportSuppressed) outcome = 'suppressed';
    // Only proof that no recipient got it permits a retry; SMTP can accept a message and lose the reply.
    else if (deliveryAcceptance(error) === 'not_accepted') { outcome = 'not_accepted'; failure = error; }
    else outcome = 'uncertain';
  }
  await scope(gymId, async tx => {
    if (outcome !== 'sent' && outcome !== 'uncertain') {
      // A definite non-send must preserve the earlier email. Never overwrite a newer attempt.
      await tx.update(signedLinks).set({ tokenHash: reservation.previousHash })
        .where(and(eq(signedLinks.id, linkId), eq(signedLinks.tokenHash, tokenHash)));
    }
    await writeAudit(tx, { gymId, actorKind: 'system', action: `link_campaign.delivery_${outcome}`,
      targetType: 'signed_link', targetId: linkId, after: { campaignId, occurrence }, occurredAt: clock.now() });
    // A released reservation no longer counts toward the occurrence or daily limit, so the job retry can send.
    if (outcome === 'not_accepted') await writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.delivery_released',
      targetType: 'signed_link', targetId: linkId, after: { campaignId, occurrence, reservation: reservationId }, occurredAt: clock.now() });
  });
  if (failure !== undefined) throw failure;
}
