// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import {
  portalWaiverListQuerySchema, waiverKindSchema, waiverSignRequestSchema,
  type WaiverSignRequest, type WaiverSignature, type WaiverTemplate,
} from '@plaingym/shared/contracts';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import { notFound } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { householdReader, payerMayActFor } from './household.js';
import type { WaiversService } from '../waivers/waivers.js';

/** `self` is the login's own member; `household` lists every current member for the payer, who signs for themselves and children. */
export type PortalWaiverScope = 'self' | 'household';
type Signing = Pick<WaiversService, 'uploadSignature' | 'sign' | 'pdf'>;

export function createPortalWaiverService(options: {
  waivers: () => Signing; households?: MemberHouseholdContext; householdScope?: typeof forHousehold; clock?: Clock;
}) {
  const households = options.households ?? createMemberHouseholdContext(), scope = options.householdScope ?? forHousehold;
  const clock = options.clock ?? defaultClock;
  const read = householdReader(scope);
  /** Members this request may act on. Anything outside the grant is not found, including another household's member. */
  async function targets(identity: PortalIdentity, kind: PortalWaiverScope, memberId?: string): Promise<string[]> {
    if (kind === 'self') {
      const context = await households.resolve(identity), own = context.memberId;
      if (!own || (memberId && memberId !== own)) notFound();
      await households.requireMember(identity, own, 'waivers.self');
      return [own];
    }
    if (memberId) return (await households.requireMember(identity, memberId, 'waivers.household'), [memberId]);
    return [...(await households.requirePayer(identity, 'waivers.household')).visibleMemberIds];
  }
  /** A payer signs for themselves and, as guardian, for children (`payerMayActFor`); anyone else signs from their own login. */
  async function signer(identity: PortalIdentity, kind: PortalWaiverScope, memberId: string, timezone: string) {
    await targets(identity, kind, memberId);
    if (kind === 'self') return;
    const context = await households.resolve(identity);
    const [member] = await read(identity, queries => queries.member(memberId));
    if (!member) notFound();
    if (!payerMayActFor(context, member, clock.now(), timezone)) throw new AppError('forbidden', 'Adults sign their own waivers');
  }
  const actor = (identity: PortalIdentity) => ({ gymId: identity.gymId, actor: { kind: 'user' as const, userId: identity.userId } });
  const page = <T>(rows: T[], query: { limit: number; offset: number }) =>
    ({ data: rows.slice(query.offset, query.offset + query.limit), pagination: { limit: query.limit, offset: query.offset, total: rows.length } });
  return {
    /** Current documents (the latest version of each family that is not retired) each member has not signed. */
    async pending(identity: PortalIdentity, kind: PortalWaiverScope, input: unknown) {
      const query = portalWaiverListQuerySchema.parse(input), ids = await targets(identity, kind, query.memberId);
      const { templates, signatures } = await read(identity, async queries => ({ templates: await queries.waiverTemplates(), signatures: await queries.waivers() }));
      const current: WaiverTemplate[] = templates.sort((a, b) => a.name.localeCompare(b.name)).map(row => ({ id: row.id, name: row.name,
        kind: waiverKindSchema.parse(row.kind), version: row.version, body: row.body, retiredAt: null, createdAt: row.createdAt.toISOString() }));
      return page(ids.flatMap(memberId => current.filter(template => !signatures.some(row => row.memberId === memberId && row.templateId === template.id))
        .map(template => ({ memberId, template }))), query);
    },
    async signed(identity: PortalIdentity, kind: PortalWaiverScope, input: unknown) {
      const query = portalWaiverListQuerySchema.parse(input), ids = await targets(identity, kind, query.memberId);
      const rows: WaiverSignature[] = (await read(identity, queries => queries.waivers())).filter(row => ids.includes(row.memberId))
        .sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime() || b.id.localeCompare(a.id))
        .map(row => ({ ...row, signedAt: row.signedAt.toISOString() }));
      return page(rows, query);
    },
    /** Signature images are checked against the grant first; the waiver service stores them under the member. */
    async upload(identity: PortalIdentity, kind: PortalWaiverScope, memberId: string, bytes: Uint8Array, timezone: string) {
      await signer(identity, kind, memberId, timezone);
      return options.waivers().uploadSignature(actor(identity), memberId, bytes);
    },
    /** Signing stays immutable: the waiver service validates the template, guardian rule and image and writes one snapshot. */
    async sign(identity: PortalIdentity, kind: PortalWaiverScope, input: WaiverSignRequest, signing: { timezone: string; ipAddress: string }) {
      const request = waiverSignRequestSchema.parse(input);
      await signer(identity, kind, request.memberId, signing.timezone);
      return options.waivers().sign(actor(identity), request, signing);
    },
    async pdf(identity: PortalIdentity, kind: PortalWaiverScope, signatureId: string) {
      const ids = await targets(identity, kind);
      if (!(await read(identity, queries => queries.waivers())).some(row => row.id === signatureId && ids.includes(row.memberId))) notFound();
      return options.waivers().pdf(identity.gymId, signatureId);
    },
  };
}
export type PortalWaiverService = ReturnType<typeof createPortalWaiverService>;
