// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, count, inArray, isNull } from 'drizzle-orm';
import { forGym, members, signedLinks, waiverTemplates, waiverSignatures, uuidv7, writeAudit } from '@plaingym/db';
import type { Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { notFound, conflict } from '../../core/interfaces/common.js';
import type { Uploads } from '../../infra/storage/index.js';
import { DemoUploads } from '../../demo/uploads.js';
import { digest, invalid, needsGuardian, readSnapshot, serializeSnapshot, validateSignatureImage } from './snapshot.js';
import { renderWaiver, validateTemplatePdf } from './pdf.js';

export interface WaiverOptions {
  scope?: typeof forGym; clock?: Clock; uploadsFor: (gymId: string) => Promise<Uploads>;
  render?: typeof renderWaiver;
}
/** Shared signed-link completion rule, matching the household current-template projection. */
export async function signedLinkWaiversComplete(tx: Transaction, memberIds: string[]): Promise<boolean> {
  if (!memberIds.length) return true;
  // Select the latest version before excluding retired families; never revive an older version.
  const templates = await tx.selectDistinctOn([waiverTemplates.name]).from(waiverTemplates)
    .orderBy(waiverTemplates.name, desc(waiverTemplates.version));
  const signatures = await tx.select({ memberId: waiverSignatures.memberId, templateId: waiverSignatures.templateId })
    .from(waiverSignatures).where(inArray(waiverSignatures.memberId, memberIds));
  return memberIds.every(id => templates.filter(t => !t.retiredAt)
    .every(t => signatures.some(s => s.memberId === id && s.templateId === t.id)));
}
const template = (r: typeof waiverTemplates.$inferSelect): c.WaiverTemplate => ({ id: r.id, name: r.name, kind: c.waiverKindSchema.parse(r.kind),
  version: r.version, body: r.body, retiredAt: r.retiredAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() });
const signature = (r: typeof waiverSignatures.$inferSelect): c.WaiverSignature => ({ id: r.id, memberId: r.memberId, templateId: r.templateId,
  snapshot: r.snapshot, snapshotHash: r.snapshotHash, signatureImageKey: r.signatureImageKey, signatureImageHash: r.signatureImageHash, signedAt: r.signedAt.toISOString() });
function boundedTemplate(input: c.WaiverCreateTemplateRequest) {
  const parsed = c.waiverCreateTemplateRequestSchema.parse(input);
  if (parsed.name.length > 200 || parsed.body.length > 80_000 || !parsed.name.trim() || !parsed.body.trim()) invalid('Template too large or empty');
  return parsed;
}
export function createWaiversService(options: WaiverOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const base = (gymId: string) => ({ id: uuidv7(clock.now().getTime()), gymId, createdAt: clock.now() });
  async function audit(tx: Transaction, ctx: MutationContext, action: string, id: string) {
    await writeAudit(tx, { gymId: ctx.gymId, actorKind: ctx.actor.kind, ...(ctx.actor.kind === 'user' ? { actorUserId: ctx.actor.userId } : {}),
      action, targetType: 'waiver', targetId: id, before: null, after: null, occurredAt: clock.now() });
  }
  async function member(tx: Transaction, id: string) {
    const [row] = await tx.select().from(members).where(eq(members.id, id)).for('update');
    if (!row || row.anonymizedAt) notFound();
    return row;
  }
  async function family(tx: Transaction, id: string) {
    const [selected] = await tx.select().from(waiverTemplates).where(eq(waiverTemplates.id, id));
    if (!selected) notFound();
    // Version one is the permanent lock anchor, even after publication or retirement.
    await tx.select({ id: waiverTemplates.id }).from(waiverTemplates)
      .where(and(eq(waiverTemplates.name, selected.name), eq(waiverTemplates.version, 1))).for('update');
    const [latest] = await tx.select().from(waiverTemplates).where(eq(waiverTemplates.name, selected.name)).orderBy(desc(waiverTemplates.version)).limit(1);
    return latest!;
  }
  async function image(gymId: string, memberId: string, key: string, hash: string) {
    if (!key.startsWith(`${gymId}/waivers/${memberId}/signatures/`)) notFound();
    const uploads = await options.uploadsFor(gymId), info = await uploads.head(key);
    if (!info || info.deletedAt || info.contentType !== 'image/png' || info.size > 256 * 1024) notFound();
    const stream = await uploads.get(key); if (!stream) notFound();
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    validateSignatureImage(bytes);
    if (digest(bytes) !== hash) invalid('Signature image digest mismatch');
    return bytes;
  }
  const service = {
    /** Complete an already-signed member link on first open, using the same locked rule as signing. */
    async completeSignedLink(gymId: string, linkId: string, memberId: string): Promise<boolean> {
      return linkedService(gymId, linkId, memberId, true).completeOnOpen();
    },
    /** Each underlying transaction rechecks the credential under the revocation lock.
     * Rendering and uploads still happen between short transactions in the existing service. */
    async uploadSignedLink(gymId: string, linkId: string, memberId: string, bytes: Uint8Array): Promise<{ signatureImageKey: string; signatureImageHash: string }> {
      return linkedService(gymId, linkId, memberId).uploadSignature({ gymId, actor: { kind: 'system' } }, memberId, bytes);
    },
    async signSignedLink(gymId: string, linkId: string, input: c.WaiverSignRequest, signing: { timezone: string; ipAddress: string }): Promise<c.WaiverSignature> {
      return linkedService(gymId, linkId, input.memberId, true).sign({ gymId, actor: { kind: 'system' } }, input, signing);
    },
    async listTemplates(gymId: string, input: unknown = {}) {
      const q = c.waiverTemplateListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const latest = tx.selectDistinctOn([waiverTemplates.name]).from(waiverTemplates)
          .orderBy(asc(waiverTemplates.name), desc(waiverTemplates.version)).as('current_waiver_templates');
        const where = and(q.includeRetired === 'true' ? undefined : isNull(latest.retiredAt), q.kind ? eq(latest.kind, q.kind) : undefined);
        const [total] = await tx.select({ value: count() }).from(latest).where(where);
        const data = await tx.select().from(latest).where(where).orderBy(asc(latest.name)).limit(q.limit).offset(q.offset);
        return { data: data.map(template), pagination: { limit: q.limit, offset: q.offset, total: total!.value } };
      });
    },
    async createTemplate(ctx: MutationContext, input: c.WaiverCreateTemplateRequest) {
      const parsed = boundedTemplate(input);
      await validateTemplatePdf(parsed);
      try { return await scope(ctx.gymId, async tx => {
        const [row] = await tx.insert(waiverTemplates).values({ ...base(ctx.gymId), ...parsed, version: 1 }).returning();
        await audit(tx, ctx, 'waiver.template.created', row!.id); return template(row!);
      }); } catch (error) {
        if (error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause && error.cause.code === '23505') conflict('Template family already exists');
        throw error;
      }
    },
    async publishTemplate(ctx: MutationContext, id: string, input: c.WaiverPublishTemplateRequest) {
      const parsed = c.waiverPublishTemplateRequestSchema.parse(input), body = boundedTemplate({ name: parsed.name, body: parsed.body, kind: parsed.kind });
      // Check authorization/existence before spending time on a trial layout.
      await scope(ctx.gymId, tx => family(tx, id));
      await validateTemplatePdf(body);
      return scope(ctx.gymId, async tx => {
        const current = await family(tx, id);
        if (current.version !== parsed.expectedVersion) conflict('Template changed; reload before saving');
        if (body.name !== current.name || body.kind !== current.kind) invalid('Template family name and kind cannot change');
        const [row] = await tx.insert(waiverTemplates).values({ ...base(ctx.gymId), ...body, version: current.version + 1 }).returning();
        await audit(tx, ctx, 'waiver.template.published', row!.id); return template(row!);
      });
    },
    async retireTemplate(ctx: MutationContext, id: string, input: c.WaiverRetireTemplateRequest) {
      const parsed = c.waiverRetireTemplateRequestSchema.parse(input);
      return scope(ctx.gymId, async tx => {
        const current = await family(tx, id);
        if (current.version !== parsed.expectedVersion) conflict('Template changed; reload before retiring');
        if (current.retiredAt) return template(current);
        const [row] = await tx.update(waiverTemplates).set({ retiredAt: clock.now() }).where(eq(waiverTemplates.id, current.id)).returning();
        await audit(tx, ctx, 'waiver.template.retired', row!.id); return template(row!);
      });
    },
    async uploadSignature(ctx: MutationContext, memberId: string, bytes: Uint8Array) {
      validateSignatureImage(bytes);
      await scope(ctx.gymId, tx => member(tx, memberId));
      const uploads = await options.uploadsFor(ctx.gymId), key = `${ctx.gymId}/waivers/${memberId}/signatures/${uuidv7(clock.now().getTime())}.png`;
      await uploads.put(key, bytes, 'image/png');
      try { await scope(ctx.gymId, async tx => { await member(tx, memberId); await audit(tx, ctx, 'waiver.signature_image.uploaded', memberId); }); }
      catch (error) { await uploads.markDeleted(key); throw error; }
      return { signatureImageKey: key, signatureImageHash: digest(bytes) };
    },
    async sign(ctx: MutationContext, input: c.WaiverSignRequest, signing: { timezone: string; ipAddress: string }) {
      const p = c.waiverSignRequestSchema.parse(input);
      // Authorize the member before touching storage. Recheck under the erasure lock at commit.
      await scope(ctx.gymId, tx => member(tx, p.memberId));
      const png = await image(ctx.gymId, p.memberId, p.signatureImageKey, p.signatureImageHash), now = clock.now();
      async function prepare(tx: Transaction) {
        const m = await member(tx, p.memberId);
        // The image key is the signing request's idempotency key. A retry must
        // carry the same signer and terms, including after later template edits.
        const [existing] = await tx.select().from(waiverSignatures).where(and(eq(waiverSignatures.memberId, m.id), eq(waiverSignatures.signatureImageKey, p.signatureImageKey)));
        if (existing) {
          const saved = readSnapshot(existing.snapshot, existing.snapshotHash);
          if (existing.templateId !== p.templateId || saved.template.version !== p.templateVersion || JSON.stringify(saved.signer) !== JSON.stringify(p.signer)
            || (saved.commitmentEndsOn ?? null) !== (p.commitmentEndsOn ?? null) || existing.signatureImageHash !== p.signatureImageHash) conflict('Signature image already used');
          return { kind: 'existing' as const, value: signature(existing) };
        }
        const current = await family(tx, p.templateId);
        if (current.id !== p.templateId || current.version !== p.templateVersion || current.retiredAt) conflict('Template changed; review the current version');
        if (needsGuardian(m.dateOfBirth, now, signing.timezone) && p.signer.kind !== 'guardian') invalid('A guardian must sign for this member');
        if (p.signer.name.length > 200 || (p.signer.kind === 'guardian' && p.signer.relationship.length > 100)) invalid('Signer details too long');
        if (p.commitmentEndsOn && (current.kind !== 'agreement' || p.commitmentEndsOn < localDate(now, signing.timezone))) invalid('Invalid commitment end date');
        const snapshot = serializeSnapshot({ template: { id: current.id, name: current.name, kind: c.waiverKindSchema.parse(current.kind), version: current.version, body: current.body },
          member: { id: m.id, firstName: m.firstName, lastName: m.lastName, dateOfBirth: m.dateOfBirth }, signer: p.signer,
          signedAt: now.toISOString(), signatureImage: { key: p.signatureImageKey, hash: p.signatureImageHash }, commitmentEndsOn: p.commitmentEndsOn ?? null });
        return { kind: 'prepared' as const, snapshot };
      }
      const prepared = await scope(ctx.gymId, prepare);
      if (prepared.kind === 'existing') return prepared.value;
      // Never persist a snapshot whose full layout or signature PNG cannot render.
      // No rendering/storage work runs inside either short transaction.
      await (options.render ?? renderWaiver)(prepared.snapshot.snapshot, prepared.snapshot.snapshotHash, png);
      return scope(ctx.gymId, async tx => {
        const checked = await prepare(tx);
        if (checked.kind === 'existing') return checked.value;
        if (checked.snapshot.snapshot !== prepared.snapshot.snapshot) conflict('Member or template changed; review before signing');
        const [row] = await tx.insert(waiverSignatures).values({ ...base(ctx.gymId), memberId: p.memberId, templateId: p.templateId, ...prepared.snapshot,
          signatureImageKey: p.signatureImageKey, signatureImageHash: p.signatureImageHash, signedAt: now, ipAddress: signing.ipAddress }).returning();
        await audit(tx, ctx, 'waiver.signed', row!.id); return signature(row!);
      });
    },
    async listSignatures(gymId: string, input: unknown = {}) {
      const q = c.waiverSignatureListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        if (q.memberId) await member(tx, q.memberId);
        if (q.templateId) { const [r] = await tx.select({ id: waiverTemplates.id }).from(waiverTemplates).where(eq(waiverTemplates.id, q.templateId)); if (!r) notFound(); }
        const where = and(q.memberId ? eq(waiverSignatures.memberId, q.memberId) : undefined, q.templateId ? eq(waiverSignatures.templateId, q.templateId) : undefined);
        const [total] = await tx.select({ value: count() }).from(waiverSignatures).where(where);
        const data = await tx.select().from(waiverSignatures).where(where).orderBy(desc(waiverSignatures.signedAt), desc(waiverSignatures.id)).limit(q.limit).offset(q.offset);
        return { data: data.map(signature), pagination: { limit: q.limit, offset: q.offset, total: total!.value } };
      });
    },
    async getSignature(gymId: string, id: string) {
      return scope(gymId, async tx => { const [row] = await tx.select().from(waiverSignatures).where(eq(waiverSignatures.id, id)); return row ? signature(row) : notFound(); });
    },
    async isDemo(gymId: string) { return (await options.uploadsFor(gymId)) instanceof DemoUploads; },
    async pdf(gymId: string, id: string) {
      const row = await service.getSignature(gymId, id), snapshot = readSnapshot(row.snapshot, row.snapshotHash);
      if (snapshot.signatureImage.key !== row.signatureImageKey || snapshot.signatureImage.hash !== row.signatureImageHash) throw new Error('Waiver image integrity failure');
      const uploads = await options.uploadsFor(gymId);
      const render = async () => {
        const png = await image(gymId, row.memberId, row.signatureImageKey, row.signatureImageHash);
        return (options.render ?? renderWaiver)(row.snapshot, row.snapshotHash, png);
      };
      const freshKey = () => `${gymId}/waivers/${row.memberId}/pdf/${uuidv7(clock.now().getTime())}.pdf`;
      let key: string;
      if (uploads instanceof DemoUploads) key = await uploads.waiverPdf(row.signatureImageKey, render, freshKey);
      else {
        const bytes = await render();
        // Production copies remain ephemeral and use the normal deferred sweep.
        key = freshKey();
        await uploads.put(key, bytes, 'application/pdf');
        await uploads.markDeleted(key);
      }
      try { await service.getSignature(gymId, id); } // Never issue a fresh URL after erasure during rendering.
      catch (error) { if (uploads instanceof DemoUploads) await uploads.markDeleted(key); throw error; }
      const url = await uploads.signedUrl(key, 300); if (!url) notFound();
      return { data: { url, expiresAt: new Date(clock.now().getTime() + 300_000).toISOString() } };
    },
  };
  function linkedService(gymId: string, linkId: string, memberId: string, completing = false) {
    const completedOnOpen = { completed: false };
    const guarded: typeof forGym = (requestedGym, fn) => scope(requestedGym, async tx => {
      if (requestedGym !== gymId) notFound();
      const [link] = await tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)).for('update');
      if (!link || link.gymId !== gymId || link.usedAt || link.revokedAt || link.expiresAt <= clock.now()
        || !['sign_waiver', 'onboarding'].includes(link.purpose)
        || (link.purpose === 'sign_waiver' && link.memberId !== memberId)) notFound();
      const [m] = await tx.select().from(members).where(and(eq(members.id, memberId), eq(members.householdId, link.householdId))).for('update');
      if (!m || m.anonymizedAt) notFound();
      const result = await fn(tx);
      // The last persisted current signature and consumption commit atomically under the link lock.
      // Onboarding is completed separately, after both the card and all waivers are confirmed.
      if (completing && link.purpose === 'sign_waiver' && result && typeof result === 'object'
        && (Object.is(result, completedOnOpen) || 'snapshotHash' in result || ('kind' in result && result.kind === 'existing'))
        && await signedLinkWaiversComplete(tx, [memberId])) {
        await tx.update(signedLinks).set({ usedAt: clock.now() }).where(eq(signedLinks.id, linkId));
        await writeAudit(tx, { gymId, actorKind: 'system', action: 'signed_link.used', targetType: 'signed_link', targetId: linkId,
          before: null, after: null, occurredAt: clock.now() });
        if (Object.is(result, completedOnOpen)) completedOnOpen.completed = true;
      }
      return result;
    });
    return { ...createWaiversService({ ...options, scope: guarded, clock }),
      completeOnOpen: async (): Promise<boolean> => (await guarded(gymId, async () => completedOnOpen)).completed,
    };
  }
  return service;
}
export type WaiversService = ReturnType<typeof createWaiversService>;
