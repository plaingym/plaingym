// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FakeMembershipLifecycle } from './membership-lifecycle.js';
import type { AssignMembership } from './membership-lifecycle.js';
import { clock, gym, otherGym, household, member, plan, id, mutation } from './test-fixtures.js';
const plans = [
  { gymId: gym, id: plan, amountCents: 10000, currency: 'CAD', interval: 'monthly' as const, commitmentMonths: 1 },
  { gymId: gym, id: id(7), amountCents: 15000, currency: 'CAD', interval: 'annual' as const, commitmentMonths: 12 },
  { gymId: gym, id: id(8), amountCents: 10000, currency: 'USD', interval: 'monthly' as const, commitmentMonths: null },
];
const request: AssignMembership = { id: id(20), householdId: household, memberId: member, planId: plan,
  startsOn: '2028-01-31', nextDueOn: '2028-02-29', firstPeriod: 'prorate_now' };
const build = () => new FakeMembershipLifecycle(plans, [{ gymId: gym, id: member, householdId: household }], clock());
describe('MembershipLifecycle fake', () => {
  it('updates plan, price, interval and due date atomically while preserving the original commitment', async () => {
    const fake = build();
    await fake.assign(mutation, request);
    const updated = await fake.update(mutation, { membershipId: request.id, revision: 1, planId: id(7),
      price: { amountCents: 12000, currency: 'CAD' }, interval: 'monthly', nextDueOn: '2028-03-15' });
    expect(updated).toMatchObject({ planId: id(7), amountCents: 12000, interval: 'monthly', nextDueOn: '2028-03-15',
      commitmentEndsOn: '2028-02-29', revision: 2 });
    const dateOnly = await fake.update(mutation, { membershipId: request.id, revision: 2, nextDueOn: '2028-04-15' });
    expect(dateOnly).toMatchObject({ amountCents: 12000, interval: 'monthly', revision: 3 });
    await expect(fake.update(mutation, { membershipId: request.id, revision: 2, interval: 'annual' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects invalid overrides without changing the membership or its revision', async () => {
    const fake = build();
    const original = await fake.assign(mutation, request);
    for (const changes of [{}, { price: { amountCents: -1, currency: 'CAD' } },
      { price: { amountCents: 100, currency: 'USD' } }, { nextDueOn: '2028-02-30' }, { planId: id(99) }]) {
      await expect(fake.update(mutation, { membershipId: request.id, revision: 1, ...changes })).rejects.toThrow();
      expect(await fake.get(gym, request.id)).toEqual(original);
    }
    await expect(fake.update({ ...mutation, gymId: otherGym }, { membershipId: request.id, revision: 1, nextDueOn: '2028-03-01' })).rejects.toMatchObject({ code: 'not_found' });
    await fake.cancel(mutation, { membershipId: request.id, revision: 1 });
    await expect(fake.update(mutation, { membershipId: request.id, revision: 2, nextDueOn: '2028-03-01' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('accepts the HTTP freeze request with an explicit null resume date', async () => {
    const fake = build();
    await fake.assign(mutation, request);
    await fake.activate(mutation, { membershipId: request.id, revision: 1 });
    expect((await fake.freeze(mutation, { membershipId: request.id, revision: 2, resumesOn: null })).resumesOn).toBeNull();
  });
  it('assigns a plan with its currency and a clamped commitment, retaining it across plan changes', async () => {
    const fake = build();
    const membership = await fake.assign(mutation, request);
    expect(membership).toMatchObject({ status: 'pending', amountCents: 10000, currency: 'CAD', commitmentEndsOn: '2028-02-29', revision: 1 });
    const updated = await fake.changePlan(mutation, { membershipId: request.id, revision: 1, planId: id(7) });
    expect(updated).toMatchObject({ amountCents: 15000, interval: 'annual', commitmentEndsOn: '2028-02-29', revision: 2 });
    await expect(fake.changePlan(mutation, { membershipId: request.id, revision: 2, planId: id(8) })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('models activate, freeze, resume and cancel with revision checks', async () => {
    const fake = build();
    await fake.assign(mutation, request);
    await expect(fake.freeze(mutation, { membershipId: request.id, revision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await fake.activate(mutation, { membershipId: request.id, revision: 1 });
    const frozen = await fake.freeze(mutation, { membershipId: request.id, revision: 2, resumesOn: '2028-03-01' });
    expect(frozen).toMatchObject({ status: 'frozen', frozenAt: '2026-10-21T12:00:00.000Z', resumesOn: '2028-03-01' });
    await expect(fake.activate(mutation, { membershipId: request.id, revision: 2 })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await fake.activate(mutation, { membershipId: request.id, revision: 3, nextDueOn: '2028-03-31' });
    const cancelled = await fake.cancel(mutation, { membershipId: request.id, revision: 4 });
    expect(cancelled.status).toBe('cancelled');
    await expect(fake.activate(mutation, { membershipId: request.id, revision: 5 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(fake.changePlan(mutation, { membershipId: request.id, revision: 5, planId: id(7) })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('serializes concurrent edits so only one save wins', async () => {
    const fake = build();
    await fake.assign(mutation, request);
    const results = await Promise.allSettled([
      fake.activate(mutation, { membershipId: request.id, revision: 1 }),
      fake.cancel(mutation, { membershipId: request.id, revision: 1 }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await fake.get(gym, request.id)).revision).toBe(2);
  });
  it('rejects cross-gym and cross-household references', async () => {
    const fake = build();
    await expect(fake.assign({ ...mutation, gymId: otherGym }, request)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.assign(mutation, { ...request, householdId: id(99) })).rejects.toMatchObject({ code: 'not_found' });
    await fake.assign(mutation, request);
    await expect(fake.get(otherGym, request.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.cancel({ ...mutation, gymId: otherGym }, { membershipId: request.id, revision: 1 })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('deduplicates assignment IDs and protects its state from caller mutation', async () => {
    const fake = build();
    const first = await fake.assign(mutation, request);
    (first as { status: string }).status = 'cancelled';
    expect((await fake.assign(mutation, request)).status).toBe('pending');
    await expect(fake.assign(mutation, { ...request, nextDueOn: '2028-03-01' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('validates trial dates and models trial activation', async () => {
    const fake = build();
    await expect(fake.assign(mutation, { ...request, initialStatus: 'trial' })).rejects.toMatchObject({ code: 'conflict' });
    const trial = await fake.assign(mutation, { ...request, trialEndsOn: '2028-02-10' });
    expect(trial.status).toBe('trial');
    expect((await fake.activate(mutation, { membershipId: request.id, revision: 1 })).status).toBe('active');
  });
});
