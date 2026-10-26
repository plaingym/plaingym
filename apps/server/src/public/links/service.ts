// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { portalSignedLinkDataSchema, type PortalSignedLinkData, type WaiverSignRequest } from '@plaingym/shared/contracts';
import type { RequestContext } from '../../core/context.js';
import type { WaiversService } from '../../areas/waivers/waivers.js';
import type { createSignedLinkCheckout } from '../../areas/billing/signed-link-checkout.js';

export interface LinkPageOptions {
  scope?: typeof forHousehold;
  waivers: Pick<WaiversService, 'uploadSignedLink' | 'signSignedLink' | 'completeSignedLink'>;
  checkout: ReturnType<typeof createSignedLinkCheckout>;
}
export function linkPrincipal(context: RequestContext) {
  const p = context.principal;
  if (p.kind !== 'signed_link' || p.gymId !== context.gym.gymId) throw new AppError('not_found', 'Link not found');
  return p;
}
export function createLinkPageService(options: LinkPageOptions) {
  const scope = options.scope ?? forHousehold;
  async function read(context: RequestContext): Promise<PortalSignedLinkData> {
    const p = linkPrincipal(context);
    try {
      return await scope({ kind: 'signed_link', gymId: p.gymId, linkId: p.linkId, now: context.clock.now() }, async q => {
        if (p.link.purpose === 'pay_invoice') {
          const [i] = await q.invoice(p.link.invoiceId);
          if (!i || i.status === 'draft') throw new AppError('not_found', 'Invoice not found');
          const lines = await q.invoiceLines(i.id);
          return portalSignedLinkDataSchema.parse({ purpose: 'pay_invoice', invoice: {
            invoice: { id: i.id, number: i.number, kind: i.kind, status: i.status, dueOn: i.dueOn, amountCents: i.amountCents, currency: i.currency, paidAt: i.paidAt?.toISOString() ?? null },
            lines: lines.map(l => ({ id: l.id, kind: l.kind, description: l.description, amountCents: l.amountCents, currency: l.currency, quantity: l.quantity,
              taxRateMillionths: l.taxRateMillionths, taxInclusive: l.taxInclusive })),
          } });
        }
        if (p.link.purpose === 'update_card') return { purpose: 'update_card', paymentMethods: await q.paymentMethods() };
        const people = p.link.purpose === 'sign_waiver' ? await q.member(p.link.memberId) : await q.members();
        if (p.link.purpose === 'sign_waiver' && people.length !== 1) throw new AppError('not_found', 'Member not found');
        const members = people.map(m => ({ id: m.id, firstName: m.firstName, lastName: m.lastName, dateOfBirth: m.dateOfBirth, revision: m.revision }));
        const templates = (await q.waiverTemplates()).map(t => ({ id: t.id, name: t.name, body: t.body, kind: t.kind, version: t.version, retiredAt: null, createdAt: t.createdAt.toISOString() }));
        const signatures = (await q.waivers()).map(s => ({ ...s, signedAt: s.signedAt.toISOString() }));
        return portalSignedLinkDataSchema.parse(p.link.purpose === 'sign_waiver'
          ? { purpose: p.link.purpose, member: members[0], templates, signatures }
          : { purpose: p.link.purpose, members, templates, signatures, paymentMethods: await q.paymentMethods() });
      });
    } catch (error) {
      if (error instanceof Error && ['Household access denied', 'Payer access required'].includes(error.message)) throw new AppError('not_found', 'Link not found');
      throw error;
    }
  }
  async function member(context: RequestContext, memberId?: string) {
    const data = await read(context);
    if (data.purpose === 'sign_waiver' && (!memberId || memberId === data.member.id)) return data.member.id;
    if (data.purpose === 'onboarding' && data.members.some(m => m.id === memberId)) return memberId!;
    throw new AppError('not_found', 'Member not found');
  }
  return {
    read,
    async completeWaiverOnOpen(context: RequestContext) {
      const data = await read(context), p = linkPrincipal(context);
      if (data.purpose !== 'sign_waiver') return false;
      return options.waivers.completeSignedLink(p.gymId, p.linkId, data.member.id);
    },
    async upload(context: RequestContext, pngBase64: string, memberId?: string) {
      const id = await member(context, memberId), p = linkPrincipal(context);
      return options.waivers.uploadSignedLink(p.gymId, p.linkId, id, Buffer.from(pngBase64, 'base64'));
    },
    async sign(context: RequestContext, input: Omit<WaiverSignRequest, 'memberId'> & { memberId?: string }) {
      const id = await member(context, input.memberId), p = linkPrincipal(context);
      return options.waivers.signSignedLink(p.gymId, p.linkId, { ...input, memberId: id }, { timezone: context.gym.timezone, ipAddress: context.clientIp ?? 'unknown' });
    },
    async checkout(context: RequestContext) {
      const data = await read(context), p = linkPrincipal(context);
      if (data.purpose === 'sign_waiver') throw new AppError('not_found', 'Link not found');
      return options.checkout.start(p.gymId, p.linkId);
    },
    async complete(context: RequestContext, sessionId: string | null) {
      const data = await read(context), p = linkPrincipal(context);
      if (data.purpose === 'sign_waiver') throw new AppError('not_found', 'Link not found');
      return options.checkout.complete(p.gymId, p.linkId, sessionId);
    },
  };
}
export type LinkPageService = ReturnType<typeof createLinkPageService>;
