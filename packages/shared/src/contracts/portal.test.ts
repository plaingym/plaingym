// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import { canMember, isRoutePermission } from '../permissions.js';
import type { households, members, memberships, paymentMethods, classSessions, attendances, memberRanks } from '../../../db/src/schema/index.js';
import {
  portalContracts, portalSignedLinkContracts, portalContextSchema,
  portalMemberSchema, portalMemberUpdateRequestSchema, portalHouseholdUpdateRequestSchema,
  portalHouseholdSchema, portalScheduleQuerySchema, portalSessionSchema, portalInvoiceResponseSchema, portalPaymentMethodsResponseSchema, portalPaymentMethodSchema,
  portalSignedLinkDataSchema, portalCheckinCodeResponseSchema,
  type PortalMember, type PortalHousehold, type PortalMembership, type PortalSession,
  type PortalAttendance, type PortalRankHistory, type PortalPaymentMethod,
} from './index.js';

const id = '019a08bf-1234-7000-8000-000000000001';
const other = '019a08bf-1234-7000-8000-000000000002';
const member = { id, firstName: 'Alex', lastName: 'Example', email: null, phone: null, dateOfBirth: '2015-10-21', photoKey: null, status: 'active', emergencyContacts: [{ name: 'Parent', relationship: 'parent', phone: '555-0100' }], revision: 2 };
const invoice = { id, number: 12, kind: 'cycle', status: 'paid', dueOn: '2026-10-21', amountCents: 1000, currency: 'CAD', paidAt: '2026-10-21T12:00:00Z' };
const line = { id, kind: 'membership', description: 'Training', amountCents: 1000, currency: 'CAD', quantity: 1, taxRateMillionths: null, taxInclusive: null };
const card = { id, brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2030, isDefault: true };

describe('portal access and safe projections', () => {
  it('leaves booking endpoints to their area and gives receipts their own response schema', () => {
    expect(Object.values(portalContracts).some(contract => contract.path.includes('/bookings'))).toBe(false);
    const receipt = { data: { url: 'https://gym.example/receipt.pdf', expiresAt: '2026-10-21T12:00:00Z' } };
    expect(portalContracts.receipt.response.parse(receipt)).toEqual(receipt);
    expect(portalContracts.receipt.response).not.toBe(portalContracts.waiverPdf.response);
  });
  it('declares the payer/adult access split for every endpoint', () => {
    const payerOnly = new Set(['members', 'updateMember', 'household', 'updateHousehold', 'invoices', 'invoice', 'receipt', 'payInvoice', 'paymentMethods', 'updateCard', 'pendingHouseholdWaivers', 'signedHouseholdWaivers', 'signHouseholdWaiver', 'householdWaiverPdf', 'uploadHouseholdSignature']);
    const observedPayerOnly = new Set<string>();
    for (const [name, contract] of Object.entries(portalContracts)) {
      expect(isRoutePermission(contract.permission)).toBe(true);
      expect(canMember('payer', contract.permission.capability), name).toBe(true);
      expect(canMember('member', contract.permission.capability), name).toBe(!payerOnly.has(name));
      if (!canMember('member', contract.permission.capability)) observedPayerOnly.add(name);
    }
    expect(observedPayerOnly).toEqual(payerOnly);
    expect(Object.values(portalContracts).some((contract) => (contract.permission.capability as string) === 'memberships.manage')).toBe(false);
  });
  it('keeps payer context valid without a member login and requires a member link for adults', () => {
    expect(portalContextSchema.parse({ role: 'payer', householdId: id, memberId: null }).memberId).toBeNull();
    expect(portalContextSchema.safeParse({ role: 'member', householdId: id, memberId: null }).success).toBe(false);
  });
  it('includes emergency contacts but rejects staff-only or credential fields', () => {
    expect(portalMemberSchema.parse(member).emergencyContacts).toEqual(member.emergencyContacts);
    // A contact saved without a relationship stays valid, as in the staff schema.
    const unspecified = [{ name: 'Parent', relationship: null, phone: '555-0100' }];
    expect(portalMemberSchema.parse({ ...member, emergencyContacts: unspecified }).emergencyContacts).toEqual(unspecified);
    for (const forbidden of ['medicalNotes', 'pinHash', 'checkinCodeHash', 'qrKey', 'emailDeliverable', 'userId']) {
      expect(portalMemberSchema.safeParse({ ...member, [forbidden]: 'secret' }).success, forbidden).toBe(false);
    }
    expect(portalHouseholdSchema.safeParse({ id, name: 'Family', email: null, phone: null, address: {}, billingDay: 1, revision: 1, stripeCustomerId: 'cus_fake' }).success).toBe(false);
  });
  it('requires revisions on edits and rejects staff-managed membership state', () => {
    expect(portalMemberUpdateRequestSchema.parse({ revision: 2, phone: null })).toEqual({ revision: 2, phone: null });
    for (const revision of [undefined, 0, -1, 1.5, '2']) {
      expect(portalMemberUpdateRequestSchema.safeParse({ revision, firstName: 'New' }).success).toBe(false);
      expect(portalHouseholdUpdateRequestSchema.safeParse({ revision, name: 'New' }).success).toBe(false);
    }
    for (const forbidden of ['status', 'householdId', 'planId', 'frozenAt', 'medicalNotes']) {
      expect(portalMemberUpdateRequestSchema.safeParse({ revision: 2, [forbidden]: id }).success).toBe(false);
    }
    expect(portalHouseholdUpdateRequestSchema.safeParse({ revision: 1, billingDay: 10 }).success).toBe(false);
    expect(portalCheckinCodeResponseSchema.safeParse({ data: { memberId: id, code: 'derived-code', version: 2, revision: 3 } }).success).toBe(true);
  });
  it('checks chronology by instant rather than lexical offsets and omits coach notes', () => {
    const session = { id, name: 'Training', startsAt: '2026-11-01T01:30:00-07:00', endsAt: '2026-11-01T01:15:00-08:00', coachId: null, capacity: null, status: 'scheduled', revision: 1 };
    expect(portalSessionSchema.safeParse(session).success).toBe(true);
    expect(portalSessionSchema.safeParse({ ...session, endsAt: session.startsAt }).success).toBe(false);
    expect(portalSessionSchema.safeParse({ ...session, notes: 'Staff note' }).success).toBe(false);
    expect(portalScheduleQuerySchema.safeParse({ from: session.startsAt, to: session.endsAt, limit: '10' }).success).toBe(true);
    expect(portalScheduleQuerySchema.safeParse({ from: session.endsAt, to: session.startsAt }).success).toBe(false);
  });
  it('rejects wrong-currency invoice lines and incomplete tax snapshots', () => {
    expect(portalInvoiceResponseSchema.safeParse({ data: { invoice, lines: [line] } }).success).toBe(true);
    expect(portalInvoiceResponseSchema.safeParse({ data: { invoice, lines: [{ ...line, currency: 'USD' }] } }).success).toBe(false);
    expect(portalInvoiceResponseSchema.safeParse({ data: { invoice: { ...invoice, status: 'draft', number: null }, lines: [] } }).success).toBe(false);
    expect(portalInvoiceResponseSchema.safeParse({ data: { invoice, lines: [{ ...line, kind: 'tax' }] } }).success).toBe(false);
    expect(portalInvoiceResponseSchema.safeParse({ data: { invoice, lines: [{ ...line, kind: 'tax', taxRateMillionths: 99750, taxInclusive: false }] } }).success).toBe(true);
  });
  it('returns only masked cards and at most one default', () => {
    expect(portalPaymentMethodsResponseSchema.safeParse({ data: [card] }).success).toBe(true);
    expect(portalPaymentMethodsResponseSchema.safeParse({ data: [card, { ...card, id: other }] }).success).toBe(false);
    expect(portalPaymentMethodsResponseSchema.safeParse({ data: [card, { ...card, id: other, isDefault: false }] }).success).toBe(true);
    for (const field of ['processorId', 'pan', 'stripeCustomerId']) {
      expect(portalPaymentMethodSchema.safeParse({ ...card, [field]: 'secret' }).success).toBe(false);
    }
  });
  it('restricts each signed-link response to its purpose and omits contacts', () => {
    const linkMember = { id, firstName: 'Alex', lastName: 'Example', dateOfBirth: null, revision: 1 };
    const sign = { purpose: 'sign_waiver', member: linkMember, templates: [], signatures: [] };
    expect(portalSignedLinkDataSchema.safeParse(sign).success).toBe(true);
    expect(portalSignedLinkDataSchema.safeParse({ ...sign, member: { ...linkMember, emergencyContacts: [] } }).success).toBe(false);
    expect(portalSignedLinkDataSchema.safeParse({ ...sign, invoice }).success).toBe(false);
    expect(portalSignedLinkDataSchema.safeParse({ purpose: 'onboarding', members: [linkMember], templates: [], signatures: [], paymentMethods: [card] }).success).toBe(true);
    expect(portalSignedLinkDataSchema.safeParse({ purpose: 'update_card', paymentMethods: [card], invoices: [] }).success).toBe(false);
    for (const contract of Object.values(portalSignedLinkContracts)) expect(isRoutePermission(contract.permission)).toBe(true);
    expect(portalSignedLinkContracts.card.response.safeParse({ data: sign }).success).toBe(false);
    const signing = { templateId: id, templateVersion: 1, signer: { kind: 'self', name: 'Alex' }, signatureImageKey: 'gym/signature.png', signatureImageHash: 'a'.repeat(64), consent: true };
    expect(portalSignedLinkContracts.signWaiver.body.safeParse(signing).success).toBe(true);
    expect(portalSignedLinkContracts.signWaiver.body.safeParse({ ...signing, memberId: other }).success).toBe(false);
  });
  it('uses fields that exist in the locked schema', () => {
    expectTypeOf<Pick<PortalMember, 'id' | 'email' | 'phone' | 'dateOfBirth' | 'photoKey' | 'revision'>>().toEqualTypeOf<Pick<typeof members.$inferSelect, 'id' | 'email' | 'phone' | 'dateOfBirth' | 'photoKey' | 'revision'>>();
    expectTypeOf<Exclude<keyof PortalMember, keyof typeof members.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof PortalHousehold, keyof typeof households.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof PortalMembership, keyof typeof memberships.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof PortalSession, keyof typeof classSessions.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof PortalAttendance, keyof typeof attendances.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof PortalRankHistory, keyof typeof memberRanks.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof PortalPaymentMethod, keyof typeof paymentMethods.$inferSelect>>().toEqualTypeOf<never>();
  });
});
