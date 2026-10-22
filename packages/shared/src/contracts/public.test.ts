// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRoutePermission } from '../permissions.js';
import type { plans } from '../../../db/src/schema/index.js';
import {
  publicContracts, publicJoinRequestSchema, publicTrialRequestSchema, publicDropInRequestSchema,
  publicSubmissionResponseSchema, publicPlanSchema, publicPageConfigResponseSchema, type PublicPlan,
} from './index.js';

const id = '019a08bf-1234-7000-8000-000000000001';
const contact = { name: 'Parent', email: 'Parent@EXAMPLE.COM', phone: '555-0100' };
const member = { firstName: 'Child', lastName: 'Example', dateOfBirth: '2015-10-21' };
const waiver = { templateId: id, templateVersion: 1, signer: { kind: 'guardian', name: 'Parent', relationship: 'parent' }, signatureImageKey: 'gym/signature.png', signatureImageHash: 'a'.repeat(64), consent: true };
const trial = { contact, member, honeypot: '' };

describe('core public page contracts', () => {
  it('validates a household join with children and per-member guardian signatures', () => {
    const request = { planId: id, contact, members: [{ member, waivers: [waiver] }], honeypot: '' };
    expect(publicJoinRequestSchema.parse(request).contact.email).toBe('parent@example.com');
    expect(publicJoinRequestSchema.safeParse({ ...request, members: [] }).success).toBe(false);
    expect(publicJoinRequestSchema.safeParse({ ...request, members: [{ member, waivers: [] }] }).success).toBe(false);
    expect(publicJoinRequestSchema.safeParse({ ...request, householdId: id }).success).toBe(false);
    expect(publicJoinRequestSchema.safeParse({ ...request, status: 'active' }).success).toBe(false);
    expect(publicJoinRequestSchema.safeParse({ ...request, members: [{ member, waivers: [{ ...waiver, consent: false }] }] }).success).toBe(false);
  });
  it('rejects bots, invalid dates, and invalid email rather than coercing them', () => {
    expect(publicTrialRequestSchema.safeParse(trial).success).toBe(true);
    for (const honeypot of ['bot', true, null, undefined]) expect(publicTrialRequestSchema.safeParse({ ...trial, honeypot }).success).toBe(false);
    expect(publicTrialRequestSchema.safeParse({ ...trial, member: { ...member, dateOfBirth: '2015-02-29' } }).success).toBe(false);
    expect(publicTrialRequestSchema.safeParse({ ...trial, contact: { ...contact, email: 'invalid' } }).success).toBe(false);
  });
  it('requires a drop-in waiver and has no payment input', () => {
    const dropIn = { ...trial, waivers: [waiver] };
    expect(publicDropInRequestSchema.safeParse(dropIn).success).toBe(true);
    expect(publicDropInRequestSchema.safeParse(trial).success).toBe(false);
    for (const field of ['paymentMethodId', 'amountCents', 'checkoutSessionId']) {
      expect(publicDropInRequestSchema.safeParse({ ...dropIn, [field]: 'secret' }).success).toBe(false);
    }
    expect(publicPageConfigResponseSchema.parse({ data: { gym: { name: 'Academy', revision: 1, logoKey: null, primaryColor: '#123456' }, dropInFee: { amountCents: 2000, currency: 'CAD' } } }).data.dropInFee?.amountCents).toBe(2000);
  });
  it('uses exactly the same neutral acknowledgement for all three submissions', () => {
    const acknowledgement = { data: { status: 'received' } };
    for (const name of ['trial', 'dropIn', 'join'] as const) {
      const contract = publicContracts[name];
      expect(contract.response).toBe(publicSubmissionResponseSchema);
      expect(contract.response.parse(acknowledgement)).toEqual(acknowledgement);
      for (const field of ['memberExists', 'memberId', 'householdId', 'checkoutUrl', 'portalLoginCreated']) {
        expect(contract.response.safeParse({ data: { status: 'received', [field]: true } }).success, `${name}: ${field}`).toBe(false);
      }
    }
  });
  it('exposes public plans with currency and revision, with no processor configuration', () => {
    const plan = { id, name: 'Monthly', amountCents: 10000, currency: 'CAD', interval: 'monthly', signupFeeCents: 0, trialDays: 7, commitmentMonths: null, revision: 1 };
    expect(publicPlanSchema.safeParse(plan).success).toBe(true);
    expect(publicPlanSchema.safeParse({ ...plan, currency: 'cad' }).success).toBe(false);
    expect(publicPlanSchema.safeParse({ ...plan, amountCents: 1.5 }).success).toBe(false);
    expect(publicPlanSchema.safeParse({ ...plan, processorId: 'price_fake' }).success).toBe(false);
    expect(publicPlanSchema.safeParse({ ...plan, commitmentMonths: 0 }).success).toBe(false);
    expectTypeOf<Exclude<keyof PublicPlan, keyof typeof plans.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Pick<PublicPlan, 'id' | 'name' | 'amountCents' | 'currency' | 'signupFeeCents' | 'trialDays' | 'commitmentMonths' | 'revision'>>().toEqualTypeOf<Pick<typeof plans.$inferSelect, 'id' | 'name' | 'amountCents' | 'currency' | 'signupFeeCents' | 'trialDays' | 'commitmentMonths' | 'revision'>>();
  });
  it('makes anonymous access explicit for each core public endpoint', () => {
    for (const contract of Object.values(publicContracts)) {
      expect(isRoutePermission(contract.permission)).toBe(true);
      expect(contract.permission).toEqual({ kind: 'public' });
      expect(contract.path).toMatch(/^\/api\/public\//);
    }
  });
});
