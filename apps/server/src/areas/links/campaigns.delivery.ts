// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { invoices, signedLinks, type forGym, type Transaction, uuidv7, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { deliveryAcceptance, type Email } from '../../infra/email/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { checkoutInProgress, credentialDisclosed, deliveryBlocked, deliveryHistory } from './campaigns.attempts.js';
import { campaignRecipient, completeCampaignIn } from './campaigns.model.js';
import { deliverSignedLink, validateSignedLinkDelivery, type SignedLinkDelivery } from './service.delivery.js';
import { revokeSignedLinkIn } from './service.js';

/** The request is fulfilled when its invoice no longer needs payment, including payment outside this link. */
async function completeClosedInvoiceIn(tx: Transaction, gymId: string, row: typeof signedLinks.$inferSelect, now: Date) {
  if (row.purpose !== 'pay_invoice') return false;
  const [invoice] = await tx.select({ status: invoices.status }).from(invoices).where(and(
    eq(invoices.id, row.invoiceId!), eq(invoices.householdId, row.householdId))).for('update');
  if (!invoice || ['open', 'past_due'].includes(invoice.status)) return false;
  await tx.update(signedLinks).set({ usedAt: now }).where(eq(signedLinks.id, row.id));
  await writeAudit(tx, { gymId, actorKind: 'system', action: 'signed_link.used', targetType: 'signed_link', targetId: row.id,
    after: { reason: 'invoice_closed', status: invoice.status }, occurredAt: now });
  await completeCampaignIn(tx, gymId, row.campaignId, now);
  return true;
}
/** Recheck under the link lock before customer matching or any delivery preparation. */
export function completeClosedCampaignInvoice(options: { scope: typeof forGym; clock: Clock }, gymId: string, campaignId: string, linkId: string) {
  return options.scope(gymId, async tx => {
    const [row] = await tx.select().from(signedLinks).where(and(eq(signedLinks.id, linkId), eq(signedLinks.campaignId, campaignId))).for('update');
    if (!row || campaignRecipient(row, options.clock.now()).state !== 'pending') return true;
    return completeClosedInvoiceIn(tx, gymId, row, options.clock.now());
  });
}

/** Reissue the existing recipient credential; reminders never add recipients or extend their expiry. */
export async function deliverCampaignLink(options: { scope: typeof forGym; clock: Clock; delivery: SignedLinkDelivery },
  gymId: string, campaignId: string, linkId: string, occurrence: string) {
  const { scope, clock, delivery } = options;
  const [candidate] = await scope(gymId, tx => tx.select({ purpose: signedLinks.purpose }).from(signedLinks)
    .where(and(eq(signedLinks.id, linkId), eq(signedLinks.campaignId, campaignId))));
  if (candidate?.purpose === 'unsubscribe') return;
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
  // A public format marker permits replacement guidance without retaining old secrets or their hashes.
  // It grants no authority: resolution still requires the complete token's current stored hash.
  const token = 'campaign_' + randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const reservationId = uuidv7(clock.now().getTime());
  const reserve = (mode: 'link' | 'manual' | 'skip') => scope(gymId, async tx => {
    const [row] = await tx.select().from(signedLinks).where(and(eq(signedLinks.id, linkId), eq(signedLinks.campaignId, campaignId))).for('update');
    if (!row || row.purpose === 'unsubscribe' || campaignRecipient(row, clock.now()).state !== 'pending') return;
    if (await completeClosedInvoiceIn(tx, gymId, row, clock.now())) return;
    const history = await deliveryHistory(tx, gymId, [linkId]);
    if (checkoutInProgress(history, linkId, clock.now())) {
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.delivery_deferred',
        targetType: 'signed_link', targetId: linkId, after: { campaignId, occurrence }, occurredAt: clock.now() });
      return;
    }
    if (deliveryBlocked(history, linkId, occurrence, clock.now(), gym.timezone)) return;
    let revokeUndisclosed = false;
    if (mode === 'link') await tx.update(signedLinks).set({ tokenHash }).where(eq(signedLinks.id, linkId));
    else {
      const disclosed = credentialDisclosed(history, linkId);
      if (!disclosed && mode === 'skip') await revokeSignedLinkIn(tx, { gymId, actor: { kind: 'system' } }, linkId, clock.now());
      revokeUndisclosed = !disclosed && mode === 'manual';
    }
    await writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.delivery_reserved',
      targetType: 'signed_link', targetId: linkId, after: { campaignId, occurrence, reservation: reservationId, mode }, occurredAt: clock.now() });
    return { previousHash: row.tokenHash, mode, revokeUndisclosed };
  });
  let reservation: Awaited<ReturnType<typeof reserve>>;
  let outcome = 'sent', transportEntered = false, transportSuppressed = false, failure: unknown;
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
    // A completion or revoke committed during preparation stops the queued send before anything is reserved.
    const [current] = await scope(gymId, tx => tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)));
    if (current && current.purpose !== 'unsubscribe' && current.campaignId === campaignId && campaignRecipient(current, clock.now()).state === 'pending') {
      const disclosed = await deliverSignedLink({ scope, context: { gymId, actor: { kind: 'system' } }, link: campaignRecipient(current, clock.now()).link, token,
        prepareSelected: async mode => { reservation = await reserve(mode); return !!reservation; },
        delivery: { ...prepared, email: observed }, noticeKey: 'links/campaigns:replacementNotice' });
      if (reservation && !disclosed) outcome = reservation.mode === 'skip' ? 'skipped' : 'manual';
    }
  } catch (error) {
    if (!reservation) throw error;
    if (!transportEntered || transportSuppressed) outcome = 'suppressed';
    // Only proof that no recipient got it permits a retry; SMTP can accept a message and lose the reply.
    else if (deliveryAcceptance(error) === 'not_accepted') { outcome = 'not_accepted'; failure = error; }
    else outcome = 'uncertain';
  }
  if (!reservation) return;
  const { previousHash, revokeUndisclosed } = reservation;
  await scope(gymId, async tx => {
    // Only a notice that reached SMTP closes the credential; a suppressed one stays pending for the next reminder.
    if (revokeUndisclosed && (outcome === 'manual' || outcome === 'uncertain'))
      await revokeSignedLinkIn(tx, { gymId, actor: { kind: 'system' } }, linkId, clock.now());
    if (outcome !== 'sent' && outcome !== 'uncertain') {
      // A definite non-send must preserve the earlier email. Never overwrite a newer attempt.
      await tx.update(signedLinks).set({ tokenHash: previousHash })
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
