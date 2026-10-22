// SPDX-License-Identifier: AGPL-3.0-only
import { canMember } from '@plaingym/shared';
import type { MemberPermission, MemberScope } from '@plaingym/shared';
import type { Id } from '@plaingym/shared/contracts';
import { conflict, notFound, scopedKey } from './common.js';

/** Authenticated IDs only; role and member scope are reloaded, never accepted from a request body. */
export interface PortalIdentity { readonly gymId: Id; readonly householdId: Id; readonly userId: Id; }
export type PortalContext = MemberScope & { readonly userId: Id; readonly visibleMemberIds: readonly Id[] };
export interface MemberHouseholdContext {
  resolve(identity: PortalIdentity): Promise<PortalContext>;
  /** Denials and resources outside the scope use the same not-found response. */
  requireMember(identity: PortalIdentity, memberId: Id, permission: MemberPermission): Promise<PortalContext>;
  requirePayer(identity: PortalIdentity, permission: MemberPermission): Promise<PortalContext>;
}
export interface PortalLoginFixture extends PortalIdentity {
  readonly role: 'payer' | 'member';
  readonly memberId: Id | null;
}
export interface PortalMemberFixture { readonly gymId: Id; readonly householdId: Id; readonly id: Id; }
export class FakeMemberHouseholdContext implements MemberHouseholdContext {
  #logins: PortalLoginFixture[] = [];
  readonly #members: readonly PortalMemberFixture[];
  constructor(members: readonly PortalMemberFixture[] = [], logins: readonly PortalLoginFixture[] = []) {
    this.#members = structuredClone(members);
    logins.forEach((login) => this.link(login));
  }
  link(login: PortalLoginFixture): void {
    scopedKey(login.gymId, login.userId);
    if (login.role === 'member' && login.memberId === null) conflict('Member login needs a member');
    if (login.memberId !== null && !this.#members.some((member) => member.gymId === login.gymId
      && member.householdId === login.householdId && member.id === login.memberId)) notFound();
    if (this.#logins.some((other) => other.gymId === login.gymId
      && ((other.userId === login.userId && other.householdId === login.householdId)
        || (login.memberId !== null && other.memberId === login.memberId)))) conflict('Portal login already linked');
    this.#logins.push(structuredClone(login));
  }
  revoke(identity: PortalIdentity): void {
    this.#logins = this.#logins.filter((item) => !(item.gymId === identity.gymId
      && item.userId === identity.userId && item.householdId === identity.householdId));
  }
  async resolve(identity: PortalIdentity): Promise<PortalContext> {
    const login = this.#logins.find((item) => item.gymId === identity.gymId
      && item.userId === identity.userId && item.householdId === identity.householdId) ?? notFound();
    const visibleMemberIds = this.#members.filter((member) => member.gymId === login.gymId
      && member.householdId === login.householdId && (login.role === 'payer' || member.id === login.memberId))
      .map((member) => member.id);
    const base = { gymId: login.gymId, householdId: login.householdId, userId: login.userId, visibleMemberIds };
    return login.role === 'payer'
      ? { ...base, role: 'payer', ...(login.memberId === null ? {} : { memberId: login.memberId }) }
      : { ...base, role: 'member', memberId: login.memberId! };
  }
  async requireMember(identity: PortalIdentity, memberId: Id, permission: MemberPermission): Promise<PortalContext> {
    const context = await this.resolve(identity);
    if (!canMember(context.role, permission) || !context.visibleMemberIds.includes(memberId)) notFound();
    return context;
  }
  async requirePayer(identity: PortalIdentity, permission: MemberPermission): Promise<PortalContext> {
    const context = await this.resolve(identity);
    if (context.role !== 'payer' || !canMember(context.role, permission)) notFound();
    return context;
  }
}
