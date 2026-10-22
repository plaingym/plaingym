// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { linkCampaigns, signedLinks } from '../../../db/src/schema/index.js';
import { canStaff, isRoutePermission, staffRoles, type SignedLink } from '../permissions.js';
import {
  campaignRecipientListQuerySchema, campaignReminderScheduleSchema, createLinkCampaignRequestSchema,
  createSignedLinkRequestSchema, createSignedLinkResponseSchema, linkCampaignProgressSchema,
  linkCampaignResponseSchema, linksContracts, signedLinkListQuerySchema, signedLinkListResponseSchema,
  signedLinkSchema,
  type CreateSignedLinkRequest, type LinkCampaign, type SignedLinkRecord,
} from '@plaingym/shared/contracts';

const id = '019a08bf-1234-7000-8000-000000000001';
const householdId = '019a08bf-1234-7000-8000-000000000002';
const createdAt = '2026-10-21T12:00:00Z';
const expiresAt = '2026-11-21T12:00:00Z';
const token = 'opaque_token_only_returned_at_creation_123456789';
const link = {
  id, householdId, purpose: 'onboarding', invoiceId: null, memberId: null,
  campaignId: null, expiresAt, usedAt: null, revokedAt: null, createdBy: null, createdAt,
};
const campaign = { id, name: 'Welcome', purpose: 'onboarding', createdBy: null, reminderSchedule: [3, 7, 14], completedAt: null, createdAt };
const campaignInput = { name: 'Welcome', expiresAt, reminderSchedule: [3, 7, 14] };
type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

describe('purpose-scoped signed links', () => {
  it.each([
    { purpose: 'onboarding' }, { purpose: 'update_card' },
    { purpose: 'pay_invoice', invoiceId: id }, { purpose: 'sign_waiver', memberId: id },
  ])('accepts the exact resource for $purpose', (resource) => {
    const request = { householdId, expiresAt, ...resource };
    expect(createSignedLinkRequestSchema.parse(request)).toEqual(request);
  });
  it.each([
    { purpose: 'pay_invoice' },
    { purpose: 'pay_invoice', invoiceId: null },
    { purpose: 'pay_invoice', invoiceId: id, memberId: id },
    { purpose: 'sign_waiver', invoiceId: id },
    { purpose: 'sign_waiver', memberId: id, invoiceId: id },
    { purpose: 'update_card', invoiceId: id },
    { purpose: 'onboarding', memberId: id },
    { purpose: 'admin' },
  ])('rejects mismatched resources %j', (resource) => {
    expect(createSignedLinkRequestSchema.safeParse({ householdId, expiresAt, ...resource }).success).toBe(false);
  });
  it('requires a household and an offset-bearing expiry without accepting caller-supplied hashes', () => {
    expect(createSignedLinkRequestSchema.safeParse({ purpose: 'onboarding', expiresAt }).success).toBe(false);
    expect(createSignedLinkRequestSchema.safeParse({ householdId, purpose: 'onboarding' }).success).toBe(false);
    expect(createSignedLinkRequestSchema.safeParse({ householdId, purpose: 'onboarding', expiresAt: '2026-11-21T12:00:00' }).success).toBe(false);
    expect(createSignedLinkRequestSchema.safeParse({ householdId, purpose: 'onboarding', expiresAt, tokenHash: 'hash' }).success).toBe(false);
  });
  it('matches resource nullability in stored metadata for all four purposes', () => {
    expect(signedLinkSchema.parse(link).purpose).toBe('onboarding');
    expect(signedLinkSchema.parse({ ...link, purpose: 'update_card' }).purpose).toBe('update_card');
    expect(signedLinkSchema.parse({ ...link, purpose: 'pay_invoice', invoiceId: id }).invoiceId).toBe(id);
    expect(signedLinkSchema.parse({ ...link, purpose: 'sign_waiver', memberId: id }).memberId).toBe(id);
    expect(signedLinkSchema.safeParse({ ...link, purpose: 'pay_invoice' }).success).toBe(false);
    expect(signedLinkSchema.safeParse({ ...link, invoiceId: id }).success).toBe(false);
    expect(signedLinkSchema.safeParse({ ...link, purpose: 'sign_waiver', invoiceId: id, memberId: id }).success).toBe(false);
  });
  it('returns tokens only in the creation result and rejects their accidental inclusion anywhere else', () => {
    expect(createSignedLinkResponseSchema.parse({ data: { link, token } }).data.token).toBe(token);
    expect(createSignedLinkResponseSchema.safeParse({ data: { link, token: 'short' } }).success).toBe(false);
    expect(createSignedLinkResponseSchema.safeParse({ data: { link, token: token + '/extra' } }).success).toBe(false);
    for (const field of ['token', 'tokenHash', 'url']) {
      expect(signedLinkSchema.safeParse({ ...link, [field]: token }).success).toBe(false);
      expect(createSignedLinkResponseSchema.safeParse({ data: { link: { ...link, [field]: token }, token } }).success).toBe(false);
      expect(signedLinkListResponseSchema.safeParse({
        data: [{ ...link, [field]: token }], pagination: { limit: 50, offset: 0, total: 1 },
      }).success).toBe(false);
    }
  });
  it('allows revoked/used metadata for staff without implying that the link can be redeemed', () => {
    expect(signedLinkSchema.parse({ ...link, usedAt: createdAt }).usedAt).toBe(createdAt);
    expect(signedLinkSchema.parse({ ...link, revokedAt: createdAt }).revokedAt).toBe(createdAt);
    // Validity is rechecked with the injected clock by forHousehold at redemption, not by metadata parsing.
  });
});

describe('link campaigns', () => {
  it('accepts no reminders or a strictly increasing schedule of positive whole days', () => {
    expect(campaignReminderScheduleSchema.parse([])).toEqual([]);
    expect(campaignReminderScheduleSchema.parse([3, 7, 14])).toEqual([3, 7, 14]);
    for (const schedule of [[0], [-1], [1.5], ['3'], [7, 3], [3, 3], [2_147_483_648]]) {
      expect(campaignReminderScheduleSchema.safeParse(schedule).success).toBe(false);
    }
  });
  it('requires each recipient to identify exactly the campaign purpose resource', () => {
    expect(createLinkCampaignRequestSchema.parse({
      ...campaignInput, purpose: 'onboarding', recipients: [{ householdId }],
    }).purpose).toBe('onboarding');
    expect(createLinkCampaignRequestSchema.parse({
      ...campaignInput, purpose: 'update_card', recipients: [{ householdId }],
    }).purpose).toBe('update_card');
    expect(createLinkCampaignRequestSchema.parse({
      ...campaignInput, purpose: 'pay_invoice', recipients: [{ householdId, invoiceId: id }],
    }).purpose).toBe('pay_invoice');
    expect(createLinkCampaignRequestSchema.parse({
      ...campaignInput, purpose: 'sign_waiver', recipients: [{ householdId, memberId: id }],
    }).purpose).toBe('sign_waiver');
    for (const request of [
      { purpose: 'pay_invoice', recipients: [{ householdId }] },
      { purpose: 'sign_waiver', recipients: [{ householdId, invoiceId: id }] },
      { purpose: 'onboarding', recipients: [{ householdId, invoiceId: id }] },
      { purpose: 'onboarding', recipients: [] },
    ]) expect(createLinkCampaignRequestSchema.safeParse({ ...campaignInput, ...request }).success).toBe(false);
  });
  it('rejects duplicate household, invoice and waiver recipients before creating links', () => {
    for (const resource of [
      { purpose: 'onboarding', recipient: { householdId } },
      { purpose: 'update_card', recipient: { householdId } },
      { purpose: 'pay_invoice', recipient: { householdId, invoiceId: id } },
      { purpose: 'sign_waiver', recipient: { householdId, memberId: id } },
    ]) {
      expect(createLinkCampaignRequestSchema.safeParse({
        ...campaignInput, purpose: resource.purpose, recipients: [resource.recipient, resource.recipient],
      }).success).toBe(false);
    }
    // Different members/invoices in one household are separate resources, so both may receive links.
    expect(createLinkCampaignRequestSchema.safeParse({
      ...campaignInput, purpose: 'pay_invoice',
      recipients: [{ householdId, invoiceId: id }, { householdId, invoiceId: householdId }],
    }).success).toBe(true);
  });
  it('keeps progress totals consistent and excludes tokens from campaign results', () => {
    const progress = { total: 10, pending: 4, completed: 3, expired: 2, revoked: 1 };
    expect(linkCampaignProgressSchema.parse(progress)).toEqual(progress);
    expect(linkCampaignProgressSchema.safeParse({ ...progress, total: 11 }).success).toBe(false);
    expect(linkCampaignProgressSchema.safeParse({ ...progress, pending: -1 }).success).toBe(false);
    expect(linkCampaignProgressSchema.safeParse({ ...progress, completed: 3.5 }).success).toBe(false);
    expect(linkCampaignResponseSchema.parse({ data: { campaign, progress } }).data.progress.total).toBe(10);
    expect(linkCampaignResponseSchema.safeParse({ data: { campaign: { ...campaign, token }, progress } }).success).toBe(false);
  });
  it('composes purpose and pending-recipient filters with shared strict pagination', () => {
    expect(signedLinkListQuerySchema.parse({ householdId, purpose: 'pay_invoice' }))
      .toEqual({ householdId, purpose: 'pay_invoice', limit: 50, offset: 0 });
    expect(campaignRecipientListQuerySchema.parse({ state: 'pending', limit: '10' }))
      .toEqual({ state: 'pending', limit: 10, offset: 0 });
    expect(campaignRecipientListQuerySchema.safeParse({ state: 'unlimited' }).success).toBe(false);
    expect(campaignRecipientListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  it.each(staffRoles)('declares link permissions and denies coaches for %s', (role) => {
    for (const endpoint of Object.values(linksContracts)) {
      expect(isRoutePermission(endpoint.permission)).toBe(true);
      expect(canStaff([role], endpoint.permission.capability)).toBe(role !== 'coach');
    }
  });
  it('matches stored fields and the existing signed-link principal resource union', () => {
    expectTypeOf<SignedLinkRecord>().toExtend<Wire<Pick<typeof signedLinks.$inferSelect, keyof SignedLinkRecord>>>();
    expectTypeOf<LinkCampaign>().toExtend<Wire<Pick<typeof linkCampaigns.$inferSelect, keyof LinkCampaign>>>();
    expectTypeOf<CreateSignedLinkRequest>().toExtend<SignedLink>();
  });
});
