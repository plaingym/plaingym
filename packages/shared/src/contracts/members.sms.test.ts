// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { householdSchema, householdSmsSchema, memberSchema, memberSmsSchema } from '@plaingym/shared/contracts';

const createdAt = '2026-10-21T12:00:00Z';
const optedOutAt = '2026-11-20T08:30:00Z';
const consent = { at: createdAt, source: 'staff' as const };
const memberSms = { phoneValid: true, phoneE164: '+12025550123', notices: null, announcements: null };
const householdSms = { phoneValid: true, phoneE164: '+12025550123', notices: consent };
const member = {
  sms: memberSms, id: '019a08bf-1234-7000-8000-000000000001', householdId: '019a08bf-1234-7000-8000-000000000002',
  firstName: 'Ana', lastName: 'Silva', email: null, phone: '+1 202 555 0123', photoKey: null, dateOfBirth: null,
  status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt,
};
const household = {
  sms: householdSms, id: '019a08bf-1234-7000-8000-000000000002', name: 'Family', email: null,
  phone: '+1 202 555 0123', address: {}, revision: 1, createdAt,
};

describe('SMS opted-out date', () => {
  for (const [label, value] of [['set', optedOutAt], ['null', null]] as const) {
    it(`parses a member and a household sms with optedOutAt ${label}`, () => {
      expect(memberSmsSchema.parse({ ...memberSms, optedOutAt: value }).optedOutAt).toBe(value);
      expect(householdSmsSchema.parse({ ...householdSms, optedOutAt: value }).optedOutAt).toBe(value);
      expect(memberSchema.parse({ ...member, sms: { ...memberSms, optedOutAt: value } }).sms.optedOutAt).toBe(value);
      expect(householdSchema.parse({ ...household, sms: { ...householdSms, optedOutAt: value } }).sms.optedOutAt).toBe(value);
    });
  }
  it('parses a member and a household sms without optedOutAt, as lists send them', () => {
    expect(memberSmsSchema.parse(memberSms)).not.toHaveProperty('optedOutAt');
    expect(householdSmsSchema.parse(householdSms)).not.toHaveProperty('optedOutAt');
    expect(memberSchema.parse(member).sms).not.toHaveProperty('optedOutAt');
    expect(householdSchema.parse(household).sms).not.toHaveProperty('optedOutAt');
  });
  it('refuses an opted-out value that is not an instant', () => {
    expect(householdSmsSchema.safeParse({ ...householdSms, optedOutAt: 'yesterday' }).success).toBe(false);
    expect(memberSmsSchema.safeParse({ ...memberSms, optedOutAt: 0 }).success).toBe(false);
  });
});
