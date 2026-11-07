// SPDX-License-Identifier: AGPL-3.0-only
// Household denials are mapped by code: a reworded message keeps its status, and a look-alike error is not a denial.
import { describe, expect, it } from 'vitest';
import { HouseholdAccessError, type forHousehold } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import type { RequestContext } from '../../core/context.js';
import type { MemberHouseholdContext } from '../../core/interfaces/member-household.js';
import { authConfig } from '../../infra/auth/config.js';
import { createLinkPageService } from '../../public/links/service.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { createPortalInvitationService } from '../members/household-users.invitations.js';
import type { RanksService } from '../ranks/ranks.service.js';
import { createPortalBookingService } from './bookings.js';
import { createPortalCheckinService } from './checkin.js';
import { createPortalHouseholdService } from './household.js';
import { createPortalProgressService } from './progress.js';
import { createPortalScheduleService } from './schedule.js';

const memberId = '019a08bf-1234-7000-8000-000000000001', linkId = '019a08bf-1234-7000-8000-000000000002';
const identity = { gymId: '019a08bf-1234-7000-8000-000000000003', householdId: '019a08bf-1234-7000-8000-000000000004', userId: '019a08bf-1234-7000-8000-000000000005' };
const clock = new TestClock('2026-10-29T16:00:00Z');
const context = { memberId, visibleMemberIds: [memberId] };
const households = { resolve: async () => context, requireMember: async () => context, requirePayer: async () => context } as unknown as MemberHouseholdContext;
const throwing = (error: Error) => (async () => { throw error; }) as unknown as typeof forHousehold;
const config = authConfig({ AUTH_SECRET: 'denial-test-secret-at-least-32-characters-long', AUTH_PASSWORD_LOGIN: 'on' }, false);
const linkContext = { gym: { gymId: identity.gymId, timezone: 'UTC', enabledModules: new Set() }, clock,
  principal: { kind: 'signed_link', gymId: identity.gymId, linkId, link: { purpose: 'update_card' } } } as unknown as RequestContext;

/** Every place that maps a household denial, called with a boundary that refuses. */
const mappers: Record<string, (householdScope: typeof forHousehold) => Promise<unknown>> = {
  'portal bookings': scope => createPortalBookingService({ households, householdScope: scope }).list(identity, { limit: 20, offset: 0 }, memberId),
  'portal check-in': scope => createPortalCheckinService({ households, householdScope: scope, codes: () => undefined }).read(identity, memberId),
  'portal household': scope => createPortalHouseholdService({ households, householdScope: scope }).household(identity),
  'portal progress': scope => createPortalProgressService({ households, householdScope: scope, ranks: () => ({}) as RanksService }).progress(identity, memberId),
  'portal schedule': scope => createPortalScheduleService({ households, householdScope: scope }).members(identity),
  'household attendance': scope => createAttendanceQueries({ householdScope: scope }).history({ kind: 'household', identity }, { memberId }, { limit: 20, offset: 0 }),
  'signed-link pages': scope => createLinkPageService({ scope, waivers: {} as never, checkout: {} as never }).read(linkContext),
  'onboarding claims': scope => createPortalInvitationService({ config, householdScope: scope, smtpConfigured: async () => false, mailer: async () => null,
    loginLink: async () => undefined, database: () => ({}) as never }).claimOnboarding(identity.gymId, linkId, { email: 'a@example.test' }, clock),
};
/** The mappers that also hide a payer-only refusal; the rest never reach a payer-only read. */
const payerMappers = ['portal household', 'signed-link pages'];

describe('household denial mapping', () => {
  it('exposes the code, with messages callers may reword', () => {
    expect(new HouseholdAccessError('household_access_denied')).toMatchObject({ code: 'household_access_denied', message: 'Household access denied' });
    expect(new HouseholdAccessError('payer_access_required')).toMatchObject({ code: 'payer_access_required', message: 'Payer access required' });
    expect(new HouseholdAccessError('payer_access_required', 'Reworded')).toMatchObject({ code: 'payer_access_required', message: 'Reworded' });
  });
  it.each(Object.keys(mappers))('%s answers not found for the code, whatever the message says', async name => {
    await expect(mappers[name]!(throwing(new HouseholdAccessError('household_access_denied', 'Reworded')))).rejects.toMatchObject({ code: 'not_found' });
  });
  it.each(payerMappers)('%s answers not found for a payer-only refusal', async name => {
    await expect(mappers[name]!(throwing(new HouseholdAccessError('payer_access_required', 'Reworded')))).rejects.toMatchObject({ code: 'not_found' });
  });
  it.each(Object.keys(mappers))('%s does not mistake another error with the same message for a denial', async name => {
    const lookalike = new Error('Household access denied');
    await expect(mappers[name]!(throwing(lookalike))).rejects.toBe(lookalike);
  });
});
