// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { forGym, type Transaction, members, households, auditEvents, waiverTemplates, uuidv7, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../core/clock.js';
import { logError } from '../../core/log.js';
import { readGymSettings } from '../../areas/settings/settings.js';
import { recordLeadIntake } from '../../areas/leads/intake.js';
import { signedLinkWaiversComplete, type WaiversService } from '../../areas/waivers/waivers.js';
import { validateSignatureImage } from '../../areas/waivers/snapshot.js';
import type { Uploads } from '../../infra/storage/index.js';

export interface PublicPagesOptions {
  scope?: typeof forGym;
  clock?: Clock;
  waivers: Pick<WaiversService, 'listTemplates' | 'uploadSignature' | 'sign' | 'document'>;
  uploadsFor?: (gymId: string) => Promise<Uploads>;
  /** Given the config read's transaction, so the settings and the fee come over one connection. */
  dropInFeeFor?: (gymId: string, tx: Transaction) => Promise<{ amountCents: number; currency: string; plusTax: boolean } | null>;
  /** Called after the intake commits, with identifiers only; the runtime queues the staff notice. */
  notifyStaff: (gymId: string, intake: { kind: 'trial' | 'drop-in'; memberId: string }) => Promise<void>;
}
const received = () => c.publicSubmissionResponseSchema.parse({ data: { status: 'received' } });
const missing = (): never => { throw new AppError('not_found', 'Admission not found'); };
/** The image types gym uploads may serve, and the largest stored file a public image route streams. */
export const servedImageTypes: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
export const maxServedImageBytes = 2_000_000;
const imageMissing = (): never => { throw new AppError('not_found', 'Image not found'); };
/** A short hash of a logo key: the logo URL's version, which changes with the file and survives settings saves. */
export const logoVersion = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 12);
/**
 * One of the gym's own uploads as a public image: not found for a key outside `prefix` (the gym's ID by default), a
 * missing or deleted file, a type that isn't a served image type or a file over the size cap.
 */
export async function serveGymImage(uploads: Uploads, gymId: string, key: string, prefix = gymId + '/') {
  if (!prefix.startsWith(gymId + '/') || !key.startsWith(prefix)) return imageMissing();
  const info = await uploads.head(key);
  if (!info || info.deletedAt || info.size > maxServedImageBytes || !servedImageTypes.includes(info.contentType)) return imageMissing();
  const stream = await uploads.get(key);
  return stream ? { stream, contentType: info.contentType } : imageMissing();
}
export function createPublicPagesService(options: PublicPagesOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const mutation = (gymId: string) => ({ gymId, actor: { kind: 'system' as const } });
  async function notifyStaff(gymId: string, intake: Parameters<PublicPagesOptions['notifyStaff']>[1], requestId?: string) {
    try { await options.notifyStaff(gymId, intake); }
    catch (error) {
      // Intake is already committed. Transport failure must not invite duplicate submissions.
      logError('public.intake.notification_failed', { gymId, kind: intake.kind, requestId: requestId ?? null }, error);
    }
  }
  function applicant(input: c.PublicTrialRequest, timezone: string) {
    if (input.member.dateOfBirth > localDate(clock.now(), timezone)
      || [input.member.firstName, input.member.lastName, input.contact.name].some(s => s.length > 200)
      || input.contact.email.length > 254 || (input.contact.phone?.length ?? 0) > 100)
      throw new AppError('invalid_request', 'Invalid applicant');
  }
  async function audit(tx: Parameters<Parameters<typeof forGym>[1]>[0], gymId: string, action: string, id: string) {
    await writeAudit(tx, { gymId, actorKind: 'system', action, targetType: 'member', targetId: id, occurredAt: clock.now() });
  }
  /** Public callers never select an existing household, even when the address matches. */
  async function intake(gymId: string, input: c.PublicTrialRequest, action: string, source: 'trial_form' | 'drop_in') {
    return scope(gymId, async tx => {
      const now = clock.now(), householdId = uuidv7(now.getTime()), id = uuidv7(now.getTime());
      await tx.insert(households).values({ id: householdId, gymId, name: input.contact.name, email: input.contact.email,
        phone: input.contact.phone ?? null, address: input.contact.address ?? {}, createdAt: now });
      await tx.insert(members).values({ id, gymId, householdId, ...input.member, email: input.contact.email, status: 'prospect', createdAt: now });
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'household.created', targetType: 'household', targetId: householdId, occurredAt: now });
      await audit(tx, gymId, action, id);
      await recordLeadIntake(tx, { gymId, memberId: id, source, now });
      return id;
    });
  }
  async function templates(gymId: string, query: c.Pagination = { limit: 50, offset: 0 }) {
    return options.waivers.listTemplates(gymId, query);
  }
  async function required(gymId: string) {
    const page = await templates(gymId, { limit: 100, offset: 0 });
    if (!page.data.length || page.pagination.total > 8) throw new AppError('unavailable', 'Contact the gym to arrange your visit');
    return page.data;
  }
  async function current(gymId: string, accepted: { templateId: string; templateVersion: number }[]) {
    const active = await required(gymId);
    if (accepted.some(a => !active.some(t => t.id === a.templateId))) {
      const ids = [...new Set(accepted.map(a => a.templateId))];
      const known = await scope(gymId, tx => tx.select({ id: waiverTemplates.id }).from(waiverTemplates).where(inArray(waiverTemplates.id, ids)));
      if (known.length !== ids.length) return missing();
    }
    if (new Set(accepted.map(a => a.templateId)).size !== active.length || accepted.length !== active.length
      || active.some(t => !accepted.some(a => a.templateId === t.id && a.templateVersion === t.version)))
      throw new AppError('conflict', 'Review all current waivers before submitting');
  }
  return {
    templates, required,
    document: (gymId: string, templateId: string) => options.waivers.document(gymId, templateId, true),
    async config(gymId: string) {
      // One short transaction on one connection; a missing gym fails on the settings read before the fee is read.
      const { gym, dropInFee } = await scope(gymId, async tx => {
        const gym = await readGymSettings(tx, gymId);
        return { gym, dropInFee: await options.dropInFeeFor?.(gymId, tx) ?? null };
      });
      return c.publicPageConfigResponseSchema.parse({ data: { gym: { name: gym.name, revision: gym.revision,
        logoKey: gym.branding.logoKey ?? null, primaryColor: gym.branding.primaryColor ?? null },
      dropInFee } });
    },
    /** `version` is the logo key's version (`logoVersion`) or the gym's current revision. */
    async logo(gymId: string, version: string) {
      const gym = await scope(gymId, tx => readGymSettings(tx, gymId)), key = gym.branding.logoKey;
      if (!key || !options.uploadsFor || version !== logoVersion(key) && version !== String(gym.revision)) return missing();
      return serveGymImage(await options.uploadsFor(gymId), gymId, key);
    },
    async trial(gymId: string, body: unknown, timezone: string, requestId?: string) {
      const input = c.publicTrialRequestSchema.parse(body); applicant(input, timezone);
      const id = await intake(gymId, input, 'public.trial.received', 'trial_form');
      await notifyStaff(gymId, { kind: 'trial', memberId: id }, requestId);
      return received();
    },
    async admit(gymId: string, body: unknown, timezone: string) {
      const input = c.publicAdmissionSchema.parse(body); applicant(input, timezone);
      await current(gymId, input.signatures);
      const images = input.signatures.map(s => Buffer.from(s.pngBase64, 'base64'));
      images.forEach(validateSignatureImage);
      const id = await intake(gymId, input, 'public.drop_in.admitted', 'drop_in');
      const data = [];
      for (const [i, accepted] of input.signatures.entries()) {
        const image = await options.waivers.uploadSignature(mutation(gymId), id, images[i]!);
        data.push({ templateId: accepted.templateId, templateVersion: accepted.templateVersion, ...image });
      }
      return { data };
    },
    async dropIn(gymId: string, body: unknown, timezone: string, ipAddress: string, requestId?: string) {
      const input = c.publicDropInRequestSchema.parse(body); applicant(input, timezone);
      await current(gymId, input.waivers);
      const id = input.waivers[0]!.signatureImageKey.split('/')[2];
      if (!id || !c.idSchema.safeParse(id).success
        || input.waivers.some(w => !w.signatureImageKey.startsWith(`${gymId}/waivers/${id}/signatures/`))) return missing();
      // A leaked staff image key cannot enroll, edit, or sign for an existing member.
      await scope(gymId, async tx => {
        const [m] = await tx.select().from(members).where(eq(members.id, id));
        const [admission] = await tx.select({ id: auditEvents.id }).from(auditEvents)
          .where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, 'public.drop_in.admitted'))).limit(1);
        if (!m || !admission || m.anonymizedAt || !['prospect', 'visitor'].includes(m.status)) return missing();
        const [home] = await tx.select().from(households).where(eq(households.id, m.householdId));
        if (!home || home.email !== input.contact.email || home.name !== input.contact.name
          || home.phone !== (input.contact.phone ?? null) || !isDeepStrictEqual(home.address, input.contact.address ?? {})
          || m.firstName !== input.member.firstName || m.lastName !== input.member.lastName || m.dateOfBirth !== input.member.dateOfBirth) return missing();
      });
      for (const acceptance of input.waivers) {
        await options.waivers.sign(mutation(gymId), { ...acceptance, memberId: id }, { timezone, ipAddress });
      }
      const changed = await scope(gymId, async tx => {
        const [m] = await tx.select().from(members).where(eq(members.id, id)).for('update');
        if (!m || m.anonymizedAt || !['prospect', 'visitor'].includes(m.status)) return missing();
        if (!await signedLinkWaiversComplete(tx, [id])) throw new AppError('conflict', 'Review all current waivers before submitting');
        if (m.status === 'visitor') return false;
        await tx.update(members).set({ status: 'visitor', revision: m.revision + 1 }).where(eq(members.id, id));
        await audit(tx, gymId, 'public.drop_in.received', id);
        return true;
      });
      if (changed) await notifyStaff(gymId, { kind: 'drop-in', memberId: id }, requestId);
      return received();
    },
  };
}
export type PublicPagesService = ReturnType<typeof createPublicPagesService>;
