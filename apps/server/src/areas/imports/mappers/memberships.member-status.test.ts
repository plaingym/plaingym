// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, leads, members, memberships, uuidv7, type Transaction } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ImportPlanRequest, ImportTargetField } from '@plaingym/shared/contracts';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { createMembershipService } from '../../billing/memberships.js';
import { inactiveStanding } from '../../kiosk/standing/standing.js';
import { createMembersService } from '../../members/members.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { autoMatch, csvLine, parseCsv } from '../pipeline.csv.js';
import { createImportPipeline } from '../pipeline.js';
import { membershipsMapper } from './memberships.js';
import type { MapperContext } from './registry.js';

const db = useTestDatabase(), factory = createFactories(db);
type Cells = Partial<Record<ImportTargetField, string>>;
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2028-03-10T12:00:00Z');
  await factory('gyms', gymId, { timezone: 'America/Vancouver', currency: 'CAD' });
  const plan = await factory('plans', gymId, { currency: 'CAD' });
  const actor = { gymId, actor: { kind: 'system' as const } };
  const uploads = new FakeUploads(gymId, clock), jobs = new FakeJobs(clock);
  // Use the production mapper registry, including the people-to-memberships path.
  const pipeline = createImportPipeline({ scope: db.forGym, clock, jobs, uploadsFor: async () => uploads });
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  const people = createMembersService(options), lifecycle = createMembershipService(options);
  const document = (records: Cells[]) => {
    const fields = [...new Set(records.flatMap(row => Object.keys(row)))];
    return csvLine(fields) + records.map(row => csvLine(fields.map(field => row[field as ImportTargetField] ?? ''))).join('');
  };
  async function run(mapper: 'people' | 'memberships', records: Cells[], duplicatePolicy: ImportPlanRequest['duplicatePolicy'] = 'error') {
    const text = document(records), upload = await pipeline.upload(actor, new File([text], 'members.csv'));
    const job = await pipeline.start(actor, { uploadId: upload.id, mapper, duplicatePolicy,
      mapping: autoMatch(parseCsv(text).columns), dryRun: false }, 'America/Vancouver');
    await pipeline.run(gymId, job.id);
    const result = await pipeline.get(gymId, job.id);
    expect(result).toMatchObject({ status: 'succeeded', committedRows: records.length, errorCount: 0 });
    return result;
  }
  const read = () => db.forGym(gymId, async tx => ({
    people: await tx.select().from(members).orderBy(asc(members.id)),
    memberships: await tx.select().from(memberships).orderBy(asc(memberships.id)),
    leads: await tx.select().from(leads).orderBy(asc(leads.id)),
    audits: await tx.select().from(auditEvents).orderBy(asc(auditEvents.id)),
  }));
  async function analyzed(records: Cells[]) {
    const source = parseCsv(document(records)), context: MapperContext = { ...actor, clock, timezone: 'America/Vancouver',
      runId: uuidv7(), sourceRows: source.rows };
    const planned = await db.forGym(gymId, tx => membershipsMapper.analyze(tx, source.rows,
      { mapper: 'memberships', uploadId: uuidv7(), duplicatePolicy: 'error', mapping: autoMatch(source.columns) }, context));
    expect(planned.every(row => row.issues.length === 0)).toBe(true);
    return (tx: Transaction) => membershipsMapper.commit(tx, planned, context);
  }
  return { gymId, clock, plan, actor, people, lifecycle, run, read, analyzed };
}
const renewal = (email: string, plan: string): Cells => ({ email, plan, nextDueOn: '2028-03-15' });

describe('imported memberships reconcile member status against PostgreSQL', () => {
  it.each([undefined, 'cancelled', 'frozen'] as const)('activates a person imported with status %s and admits them at the kiosk', async status => {
    const f = await fixture();
    await f.run('people', [
      { email: 'member@example.test', firstName: 'Sam', lastName: 'Member', ...(status ? { status } : {}) },
      { email: 'untouched@example.test', firstName: 'Pat', lastName: 'Untouched', ...(status ? { status: 'cancelled' } : {}) },
    ]);
    const before = await f.read(), member = before.people.find(row => row.email === 'member@example.test')!;
    const untouched = before.people.find(row => row.email === 'untouched@example.test')!;
    expect(member.status).toBe(status ?? 'prospect');
    const lead = await factory('leads', f.gymId, { memberId: member.id, stage: 'lost', lostAt: f.clock.now(), lostReason: 'Other' });
    const foreignGym = uuidv7(); await factory('gyms', foreignGym);
    const foreign = await factory('members', foreignGym, { email: member.email, status: 'prospect' });
    const result = await f.run('memberships', [renewal(member.email!, f.plan.id)]);
    const after = await f.read(), membership = after.memberships[0]!;
    expect(after.people.find(row => row.id === member.id)).toMatchObject({ status: 'active', revision: member.revision + 1 });
    expect(after.people.find(row => row.id === untouched.id)).toEqual(untouched);
    expect(after.leads).toMatchObject([{ id: lead.id, stage: 'won', wonAt: f.clock.now(), lostAt: null, lostReason: null }]);
    expect(after.audits.filter(row => row.action === 'billing.member.activated')).toMatchObject([{
      actorKind: 'system', occurredAt: f.clock.now(), targetId: member.id,
      before: { status: member.status, revision: member.revision },
      after: { status: 'active', revision: member.revision + 1, membershipId: membership.id, cause: 'billing.membership.imported' },
    }]);
    expect(after.audits.find(row => row.action === 'billing.membership.imported')).toMatchObject({ after: { importId: result.id } });
    expect(await inactiveStanding(db.forGym).check({ gymId: f.gymId, memberId: member.id, clock: f.clock })).toEqual({ status: 'ok' });
    expect(await db.forGym(foreignGym, tx => tx.select().from(members).where(eq(members.id, foreign.id)))).toEqual([foreign]);
    // The import's active history must also count after its final cancellation.
    await f.lifecycle.cancel(f.actor, { membershipId: membership.id, revision: membership.revision });
    expect(await f.people.getMember(f.gymId, member.id)).toMatchObject({ status: 'cancelled', revision: member.revision + 2 });
  });

  it('reconciles an active update, wins its lead and leaves a repeated update without duplicate status or lead audits', async () => {
    const f = await fixture(), member = await factory('members', f.gymId, { email: 'update@example.test', status: 'cancelled' });
    const membership = await factory('memberships', f.gymId, { memberId: member.id, householdId: member.householdId,
      planId: f.plan.id, status: 'active', startsOn: '2028-03-01', nextDueOn: '2028-03-15' });
    await factory('leads', f.gymId, { memberId: member.id, stage: 'contacted' });
    const records = [renewal(member.email!, f.plan.id)];
    await f.run('memberships', records, 'update');
    const first = await f.read();
    expect(first.people[0]).toMatchObject({ status: 'active', revision: 2 });
    expect(first.leads[0]).toMatchObject({ stage: 'won' });
    expect(first.audits.find(row => row.action === 'billing.member.activated')).toMatchObject({
      after: { cause: 'billing.membership.import_updated', membershipId: membership.id } });
    await f.run('memberships', records, 'update');
    const second = await f.read();
    expect(second.people).toEqual(first.people); expect(second.leads).toEqual(first.leads);
    expect(second.audits.filter(row => row.action === 'billing.member.activated')).toHaveLength(1);
    expect(second.audits.filter(row => row.action === 'lead.stage_changed')).toHaveLength(1);
  });

  it('keeps an updated pending assignment and its lead pending', async () => {
    const f = await fixture(), member = await factory('members', f.gymId, { email: 'pending@example.test', status: 'prospect' });
    await f.lifecycle.assign(f.actor, { id: uuidv7(), memberId: member.id, householdId: member.householdId, planId: f.plan.id,
      startsOn: '2028-03-01', nextDueOn: '2028-03-15', firstPeriod: 'next_billing_date', initialStatus: 'pending' });
    await factory('leads', f.gymId, { memberId: member.id, stage: 'contacted' });
    await f.run('memberships', [renewal(member.email!, f.plan.id)], 'update');
    const after = await f.read();
    expect(after.people[0]).toMatchObject({ status: 'prospect', revision: 1 });
    expect(after.memberships[0]).toMatchObject({ status: 'pending' });
    expect(after.leads[0]).toMatchObject({ stage: 'contacted', wonAt: null });
    expect(after.audits.filter(row => row.action.startsWith('billing.member.'))).toEqual([]);
    await f.lifecycle.cancel(f.actor, { membershipId: after.memberships[0]!.id, revision: after.memberships[0]!.revision });
    expect(await f.people.getMember(f.gymId, member.id)).toMatchObject({ status: 'prospect', revision: 1 });
  });

  it('handles two plans for one member in one chunk with one member revision change', async () => {
    const f = await fixture(), member = await factory('members', f.gymId, { email: 'two@example.test' });
    const other = await factory('plans', f.gymId, { currency: 'CAD' });
    await f.run('memberships', [renewal(member.email!, f.plan.id), renewal(member.email!, other.id)]);
    const after = await f.read();
    expect(after.memberships).toHaveLength(2);
    expect(after.people[0]).toMatchObject({ status: 'active', revision: 2 });
    expect(after.audits.filter(row => row.action === 'billing.member.activated')).toHaveLength(1);
    expect(after.leads).toMatchObject([{ stage: 'won' }]);
  });

  it('rolls back the membership, member revision, lead and audits with the chunk', async () => {
    const f = await fixture(), member = await factory('members', f.gymId, { email: 'rollback@example.test' });
    await factory('leads', f.gymId, { memberId: member.id, stage: 'contacted' });
    const commit = await f.analyzed([renewal(member.email!, f.plan.id)]), before = await f.read();
    await expect(db.forGym(f.gymId, async tx => { await commit(tx); throw new Error('abort chunk'); })).rejects.toThrow('abort chunk');
    expect(await f.read()).toEqual(before);
  });

  it('rejects a stale member revision without changing the membership, lead or audits', async () => {
    const f = await fixture(), member = await factory('members', f.gymId, { email: 'stale@example.test' });
    const commit = await f.analyzed([renewal(member.email!, f.plan.id)]);
    await f.people.updateMember(f.actor, member.id, { revision: member.revision, status: 'visitor' });
    const before = await f.read();
    await expect(db.forGym(f.gymId, commit)).rejects.toMatchObject({ name: 'RevisionConflictError' });
    expect(await f.read()).toEqual(before);
  });
});
