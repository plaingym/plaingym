// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from '@plaingym/shared';
import type { Id, IsoDate, IsoInstant, Money, Revision } from '@plaingym/shared/contracts';
import { dateSchema, moneySchema } from '@plaingym/shared/contracts';
import { clock as systemClock } from '../clock.js';
import { conflict, notFound, requireRevision, scopedKey } from './common.js';
import type { MutationContext } from './common.js';

export type MembershipStatus = 'pending' | 'trial' | 'active' | 'frozen' | 'cancelled';
export interface MembershipSnapshot extends Money {
  readonly id: Id;
  readonly householdId: Id;
  readonly memberId: Id;
  readonly planId: Id;
  readonly interval: 'monthly' | 'annual';
  readonly status: MembershipStatus;
  readonly startsOn: IsoDate;
  readonly nextDueOn: IsoDate;
  readonly trialEndsOn: IsoDate | null;
  readonly commitmentEndsOn: IsoDate | null;
  readonly frozenAt: IsoInstant | null;
  readonly resumesOn: IsoDate | null;
  readonly cancelledAt: IsoInstant | null;
  readonly revision: Revision;
}
export interface AssignMembership {
  readonly id: Id;
  readonly householdId: Id;
  readonly memberId: Id;
  readonly planId: Id;
  readonly startsOn: IsoDate;
  readonly nextDueOn: IsoDate;
  readonly trialEndsOn?: IsoDate;
  readonly initialStatus?: 'pending' | 'trial' | 'active';
  /** Invoice engine handles the first charge after assignment; this call never charges. */
  readonly firstPeriod: 'prorate_now' | 'next_billing_date';
}
export interface UpdateMembership extends MembershipEdit {
  readonly planId?: Id | undefined;
  readonly nextDueOn?: IsoDate | undefined;
  readonly interval?: 'monthly' | 'annual' | undefined;
  readonly price?: Money | undefined;
}
export interface MembershipEdit { readonly membershipId: Id; readonly revision: Revision; }
/** Implementations compare revisions, write audits and schedule billing work atomically. */
export interface MembershipLifecycle {
  assign(context: MutationContext, request: AssignMembership): Promise<MembershipSnapshot>;
  activate(context: MutationContext, request: MembershipEdit & { nextDueOn?: IsoDate }): Promise<MembershipSnapshot>;
  freeze(context: MutationContext, request: MembershipEdit & { resumesOn?: IsoDate | null }): Promise<MembershipSnapshot>;
  cancel(context: MutationContext, request: MembershipEdit): Promise<MembershipSnapshot>;
  update(context: MutationContext, request: UpdateMembership): Promise<MembershipSnapshot>;
  /** Convenience for a plan-only update. Resume uses activate with nextDueOn. */
  changePlan(context: MutationContext, request: MembershipEdit & { planId: Id }): Promise<MembershipSnapshot>;
  get(gymId: Id, membershipId: Id): Promise<MembershipSnapshot>;
}
export interface MembershipPlanFixture extends Money {
  readonly id: Id;
  readonly gymId: Id;
  readonly interval: 'monthly' | 'annual';
  readonly commitmentMonths: number | null;
}
export interface MembershipMemberFixture { readonly id: Id; readonly gymId: Id; readonly householdId: Id; }
/** Month ends clamp instead of overflowing into the following month. */
function commitmentEnd(startsOn: IsoDate, months: number | null): IsoDate | null {
  dateSchema.parse(startsOn);
  if (months === null) return null;
  if (!Number.isSafeInteger(months) || months < 1) throw new Error('Invalid commitment length');
  const start = new Date(startsOn + 'T00:00:00Z');
  const end = new Date(start);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(end);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  end.setUTCDate(Math.min(start.getUTCDate(), lastDay.getUTCDate()));
  return dateSchema.parse(end.toISOString().slice(0, 10));
}
export class FakeMembershipLifecycle implements MembershipLifecycle {
  readonly #memberships = new Map<string, MembershipSnapshot>();
  readonly #assignments = new Map<string, string>();
  readonly #plans: readonly MembershipPlanFixture[];
  readonly #members: readonly MembershipMemberFixture[];
  constructor(plans: readonly MembershipPlanFixture[] = [], members: readonly MembershipMemberFixture[] = [],
    readonly clock: Clock = systemClock) {
    this.#plans = structuredClone(plans);
    this.#members = structuredClone(members);
  }
  #plan(gymId: Id, planId: Id): MembershipPlanFixture {
    const plan = this.#plans.find((item) => item.gymId === gymId && item.id === planId) ?? notFound();
    moneySchema.parse(planMoney(plan));
    if (plan.amountCents < 0) conflict('Plan amount must not be negative');
    return plan;
  }
  async assign(context: MutationContext, request: AssignMembership): Promise<MembershipSnapshot> {
    const key = scopedKey(context.gymId, request.id);
    const fingerprint = JSON.stringify(request);
    if (this.#assignments.has(key)) {
      if (this.#assignments.get(key) !== fingerprint) conflict('Assignment ID reused with different parameters');
      return this.get(context.gymId, request.id);
    }
    const plan = this.#plan(context.gymId, request.planId);
    if (!this.#members.some((member) => member.gymId === context.gymId && member.id === request.memberId
      && member.householdId === request.householdId)) notFound();
    dateSchema.parse(request.startsOn);
    dateSchema.parse(request.nextDueOn);
    if (request.trialEndsOn !== undefined) dateSchema.parse(request.trialEndsOn);
    const status = request.initialStatus ?? (request.trialEndsOn ? 'trial' : 'pending');
    if (status === 'trial' && (!request.trialEndsOn || request.trialEndsOn <= request.startsOn))
      conflict('Trial must end after it starts');
    const membership: MembershipSnapshot = {
      id: request.id, householdId: request.householdId, memberId: request.memberId, planId: plan.id,
      ...planMoney(plan), interval: plan.interval, status, startsOn: request.startsOn, nextDueOn: request.nextDueOn,
      trialEndsOn: request.trialEndsOn ?? null, commitmentEndsOn: commitmentEnd(request.startsOn, plan.commitmentMonths),
      frozenAt: null, resumesOn: null, cancelledAt: null, revision: 1,
    };
    this.#memberships.set(key, membership);
    this.#assignments.set(key, fingerprint);
    return structuredClone(membership);
  }
  async get(gymId: Id, membershipId: Id): Promise<MembershipSnapshot> {
    return structuredClone(this.#memberships.get(scopedKey(gymId, membershipId)) ?? notFound());
  }
  async #edit(context: MutationContext, request: MembershipEdit,
    update: (current: MembershipSnapshot) => Partial<MembershipSnapshot>): Promise<MembershipSnapshot> {
    // No await between the revision check and write: concurrent fake calls serialize here.
    const key = scopedKey(context.gymId, request.membershipId);
    const current = this.#memberships.get(key) ?? notFound();
    requireRevision(current.revision, request.revision);
    const next = { ...current, ...update(current), revision: current.revision + 1 };
    this.#memberships.set(key, next);
    return structuredClone(next);
  }
  async activate(context: MutationContext, request: MembershipEdit & { nextDueOn?: IsoDate }): Promise<MembershipSnapshot> {
    return this.#edit(context, request, (current) => {
      if (!['pending', 'trial', 'frozen'].includes(current.status)) conflict('Membership cannot be activated');
      if (request.nextDueOn !== undefined) dateSchema.parse(request.nextDueOn);
      return { status: 'active', frozenAt: null, resumesOn: null,
        ...(request.nextDueOn === undefined ? {} : { nextDueOn: request.nextDueOn }) };
    });
  }
  async freeze(context: MutationContext, request: MembershipEdit & { resumesOn?: IsoDate | null }): Promise<MembershipSnapshot> {
    return this.#edit(context, request, (current) => {
      if (!['active', 'trial'].includes(current.status)) conflict('Membership cannot be frozen');
      if (request.resumesOn != null) dateSchema.parse(request.resumesOn);
      return { status: 'frozen', frozenAt: this.clock.now().toISOString(), resumesOn: request.resumesOn ?? null };
    });
  }
  async cancel(context: MutationContext, request: MembershipEdit): Promise<MembershipSnapshot> {
    return this.#edit(context, request, (current) => {
      if (current.status === 'cancelled') conflict('Membership is already cancelled');
      return { status: 'cancelled', cancelledAt: this.clock.now().toISOString(), resumesOn: null };
    });
  }
  async update(context: MutationContext, request: UpdateMembership): Promise<MembershipSnapshot> {
    return this.#edit(context, request, (current) => {
      if (current.status === 'cancelled') conflict('Cancelled membership cannot be edited');
      if ([request.planId, request.nextDueOn, request.interval, request.price].every(value => value === undefined))
        conflict('Supply a membership change');
      const plan = request.planId === undefined ? undefined : this.#plan(context.gymId, request.planId);
      if (plan && plan.currency !== current.currency) conflict('Plan currency does not match');
      if (request.price !== undefined) {
        moneySchema.parse(request.price);
        if (request.price.currency !== current.currency || request.price.amountCents < 0) conflict('Invalid membership price');
      }
      if (request.nextDueOn !== undefined) dateSchema.parse(request.nextDueOn);
      if (request.interval !== undefined && !['monthly', 'annual'].includes(request.interval)) conflict('Invalid billing interval');
      // Plan defaults apply first; explicit overrides win. Original commitment never changes.
      return { ...(plan ? { planId: plan.id, ...planMoney(plan), interval: plan.interval } : {}),
        ...(request.price === undefined ? {} : request.price),
        ...(request.interval === undefined ? {} : { interval: request.interval }),
        ...(request.nextDueOn === undefined ? {} : { nextDueOn: request.nextDueOn }) };
    });
  }
  async changePlan(context: MutationContext, request: MembershipEdit & { planId: Id }): Promise<MembershipSnapshot> {
    return this.update(context, request);
  }
}
function planMoney(plan: MembershipPlanFixture): Money { return { amountCents: plan.amountCents, currency: plan.currency }; }
