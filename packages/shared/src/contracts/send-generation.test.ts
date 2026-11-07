// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createSignedLinkRequestSchema, sendSignedLinkRequestSchema } from './links.js';
import { portalInvitationRequestSchema } from './portal.js';
import { inviteStaffRequestSchema } from './staff.js';

const sendGeneration = '01900000-0000-7000-8000-000000000001', id = '01900000-0000-7000-8000-000000000002';
const link = { purpose: 'update_card', householdId: id, expiresAt: '2026-11-20T12:00:00.000Z' };
const staff = { email: 'coach@example.test', role: 'coach' };
const portal = { email: 'payer@example.test', scope: 'payer' };

describe('send generations', () => {
  it('a signed link send needs one, and creating a link takes none', () => {
    expect(sendSignedLinkRequestSchema.safeParse({ ...link, sendGeneration }).success).toBe(true);
    expect(sendSignedLinkRequestSchema.safeParse(link).success).toBe(false);
    expect(sendSignedLinkRequestSchema.safeParse({ ...link, sendGeneration: 'attempt-1' }).success).toBe(false);
    expect(createSignedLinkRequestSchema.safeParse(link).success).toBe(true);
    expect(createSignedLinkRequestSchema.safeParse({ ...link, sendGeneration }).success).toBe(false);
  });
  it.each([
    ['staff', inviteStaffRequestSchema, staff],
    ['portal', portalInvitationRequestSchema, portal],
  ] as const)('%s invitation: emailing needs one, and printing takes none', (_name, schema, fields) => {
    expect(schema.safeParse({ ...fields, delivery: 'email', sendGeneration }).success).toBe(true);
    expect(schema.safeParse({ ...fields, delivery: 'email' }).success).toBe(false);
    expect(schema.safeParse({ ...fields, delivery: 'print' }).success).toBe(true);
    expect(schema.safeParse({ ...fields, delivery: 'print', sendGeneration }).success).toBe(false);
  });
  it('a portal invitation still tells its scopes apart under either delivery', () => {
    for (const delivery of [{ delivery: 'email', sendGeneration }, { delivery: 'print' }]) {
      expect(portalInvitationRequestSchema.safeParse({ email: portal.email, scope: 'member', memberId: id, ...delivery }).success).toBe(true);
      expect(portalInvitationRequestSchema.safeParse({ email: portal.email, scope: 'member', ...delivery }).success).toBe(false);
      expect(portalInvitationRequestSchema.safeParse({ email: portal.email, scope: 'payer', memberId: null, ...delivery }).success).toBe(true);
    }
  });
});
