// SPDX-License-Identifier: AGPL-3.0-only
import { expectTypeOf, it } from 'vitest';
import type { attendances, invoices, memberships, plans } from '@plaingym/db/schema';
import type { AttendanceEntry } from './attendance.js';
import type { InvoiceSnapshot } from './invoice-transitions.js';
import type { MembershipPlanFixture, MembershipSnapshot } from './membership-lifecycle.js';

it('keeps all record projections assignable to the locked database fields', () => {
  expectTypeOf<AttendanceEntry>().toExtend<Pick<typeof attendances.$inferSelect,
    'id' | 'memberId' | 'sessionId' | 'programId' | 'source'> & { occurredAt: string }>();
  expectTypeOf<MembershipSnapshot>().toExtend<Pick<typeof memberships.$inferSelect,
    'id' | 'householdId' | 'memberId' | 'planId' | 'interval' | 'status' | 'amountCents' | 'currency'
    | 'startsOn' | 'nextDueOn' | 'trialEndsOn' | 'commitmentEndsOn' | 'resumesOn' | 'revision'>
    & { frozenAt: string | null; cancelledAt: string | null }>();
  expectTypeOf<MembershipPlanFixture>().toExtend<Pick<typeof plans.$inferSelect,
    'id' | 'gymId' | 'amountCents' | 'currency' | 'interval' | 'commitmentMonths'>>();
  expectTypeOf<InvoiceSnapshot>().toExtend<Pick<typeof invoices.$inferSelect,
    'id' | 'householdId' | 'number' | 'kind' | 'status' | 'amountCents' | 'currency'> & { paidAt: string | null }>();
});
