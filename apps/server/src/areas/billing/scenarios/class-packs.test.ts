// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { classCreditEntries } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createAttendanceService } from '../../attendance/attendance.js';
import { usableLots } from '../packs/ledger.js';
import { createPackSalesService } from '../packs/sales.js';
import { clearJobs, workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

describe('class packs through composed billing and attendance services', () => {
  it('sells three credits, pays by card, uses two, and refunds only the unused credit; membership uses none', async () => {
    const f = await workflowFixture(db, { empty: true });
    const pack = await f.factory('classPacks', f.gymId, { credits: 3, amountCents: 9000, currency: 'USD' });
    const sales = createPackSalesService(f.common), attendance = createAttendanceService(f.common);
    const bill = await sales.sell(f.context, pack.id, { memberId: f.member.id, dueOn: '2028-03-01' });
    const ledger = () => db.forGym(f.gymId, tx => tx.select().from(classCreditEntries));
    const balance = () => db.forGym(f.gymId, async tx =>
      (await usableLots(tx, f.member.id, f.clock.now())).reduce((sum, lot) => sum + lot.remaining, 0));
    expect(await ledger()).toEqual([]);
    await f.service.charge(f.context, bill.id); await f.drain();
    expect((await f.read()).invoices[0]).toMatchObject({ id: bill.id, status: 'paid' });
    expect(await balance()).toBe(3);
    const sessions = await Promise.all([1, 2].map(() => f.factory('classSessions', f.gymId)));
    const kiosk = await f.factory('kioskDevices', f.gymId);
    const first = await attendance.record({ gymId: f.gymId, actor: { kind: 'device', deviceId: kiosk.id } },
      { memberId: f.member.id, sessionId: sessions[0]!.id, programId: null }, { source: 'kiosk' });
    const second = await attendance.record(f.context, { memberId: f.member.id, sessionId: sessions[1]!.id, programId: null });
    expect(await balance()).toBe(1);
    const paid = (await f.read()).payments[0]!;
    await f.service.refund(f.context, paid.id, { amountCents: bill.amountCents, currency: 'USD', reason: 'Pack refund' });
    await f.drain();
    expect((await f.read()).invoices[0]).toMatchObject({ status: 'refunded' });
    const entries = await ledger(), grant = entries.find(row => row.kind === 'grant')!;
    expect(entries.filter(row => row.kind === 'use').map(row => row.attendanceId).sort()).toEqual([first.id, second.id].sort());
    expect(entries.filter(row => row.kind === 'reverse')).toMatchObject([{ credits: -1, lotId: grant.id }]);
    expect(await balance()).toBe(0);
    // A member who also holds a pack keeps their credits while an active membership covers the visit.
    const subscriber = await f.factory('members', f.gymId, { householdId: f.home.id });
    await f.factory('memberships', f.gymId, { memberId: subscriber.id, householdId: f.home.id, planId: f.plan.id, status: 'active' });
    await f.factory('classCreditEntries', f.gymId, { memberId: subscriber.id, credits: 3 });
    await attendance.record(f.context, { memberId: subscriber.id, sessionId: sessions[0]!.id, programId: null });
    expect((await ledger()).filter(row => row.memberId === subscriber.id)).toMatchObject([{ kind: 'adjust', credits: 3 }]);
  });
});
