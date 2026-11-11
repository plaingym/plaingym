// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canStaff } from '../../permissions.js';
import { parseMinorUnits, formatMinorUnits } from '../../money.js';
import { billingContracts, classPackResponseSchema, createClassPackRequestSchema, updateClassPackRequestSchema, sellClassPackRequestSchema } from '../billing.js';

const input = { name: 'Ten classes', amountCents: 10000, currency: 'CAD', credits: 10 };
describe('pack catalog contracts', () => {
  it('defaults optional expiry, activation and tax links, and describes its wire response', () => {
    const pack = createClassPackRequestSchema.parse(input);
    expect(pack).toEqual({ ...input, expiryDays: null, active: true, taxRateIds: [] });
    expect(classPackResponseSchema.parse({ data: { ...pack, id: '019a08bf-1234-7000-8000-000000000001',
      createdAt: '2026-11-10T12:00:00Z', revision: 1 } }).data.credits).toBe(10);
  });
  it.each([{ credits: 0 }, { credits: 101 }, { credits: 1.5 }, { expiryDays: 0 }, { expiryDays: 3651 },
    { expiryDays: 1.5 }, { amountCents: -1 }, { name: ' ' }, { currency: 'cad' }, { gymId: 'injected' }])('refuses invalid create and update fields (%#)', changes => {
      expect(createClassPackRequestSchema.safeParse({ ...input, ...changes }).success).toBe(false);
      expect(updateClassPackRequestSchema.safeParse({ revision: 1, ...changes }).success).toBe(false);
    });
  it('requires revisions and real changes; permits explicit removal of expiry and tax links', () => {
    for (const value of [{ revision: 1 }, { name: 'Updated' }, { revision: 0, active: false }])
      expect(updateClassPackRequestSchema.safeParse(value).success).toBe(false);
    expect(updateClassPackRequestSchema.parse({ revision: 1, expiryDays: null, taxRateIds: [], active: false })).toMatchObject({ expiryDays: null });
  });
  it('uses minor-unit money parsing and checks zero- and three-decimal price steps', () => {
    for (const [currency, text] of [['JPY', '105'], ['KWD', '1.250'], ['ISK', '5']] as const) {
      const amountCents = parseMinorUnits(text, currency);
      expect(createClassPackRequestSchema.safeParse({ ...input, currency, amountCents }).success).toBe(true);
      expect(formatMinorUnits(amountCents, currency)).toBeTruthy();
    }
    for (const [currency, amountCents] of [['KWD', 1251], ['ISK', 501]] as const)
      expect(createClassPackRequestSchema.safeParse({ ...input, currency, amountCents }).success).toBe(false);
  });
  it('allows front desk to read packs and reserves editing for owners and admins', () => {
    for (const name of ['listClassPacks', 'getClassPack', 'createClassPack', 'updateClassPack'] as const) {
      const permission = billingContracts[name].permission;
      const read = name === 'listClassPacks' || name === 'getClassPack';
      expect(permission).toEqual({ kind: 'staff', capability: read ? 'billing.read' : 'plans.manage' });
      for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const)
        expect(canStaff([role], permission.capability)).toBe(role === 'owner' || role === 'admin' || read && role === 'front_desk');
    }
  });
  it('allows staff collection roles to sell, derives the payer, and validates real due dates', () => {
    const request = { memberId: '019a08bf-1234-7000-8000-000000000001', dueOn: '2028-02-29' };
    expect(sellClassPackRequestSchema.parse(request)).toEqual(request);
    for (const extra of [{ dueOn: '2026-02-29' }, { memberId: 'invalid' }, { householdId: request.memberId },
      { invoiceId: request.memberId }, { amountCents: 0 }, { credits: 100 }])
      expect(sellClassPackRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(billingContracts.sellClassPack.permission).toEqual({ kind: 'staff', capability: 'payments.record' });
  });
});
