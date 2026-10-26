// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { households, members, memberships, plans, RevisionConflictError, assertRevised, revisionGuard,
  uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { dateSchema, idSchema, type ImportIssue, type ImportPlanRequest, type ImportTargetField } from '@plaingym/shared/contracts';
import { isCalendarDate, localDate } from '@plaingym/shared/time';
import { householdDateOnOrAfter } from '../../billing/invoicing/calendar.js';
import type { CsvRow } from '../pipeline.csv.js';
import type { CsvMapper, MapperContext, PlannedRow } from './registry.js';
import { annualAnniversary, message, normalize, parseMembership, type Identity, type Source } from './memberships.parse.js';

type Reader = Pick<Transaction, 'select'>;
type Person = typeof members.$inferSelect;
type Plan = typeof plans.$inferSelect;
type Membership = typeof memberships.$inferSelect;
const livePair = (rows: Membership[], memberId: string, planId: string) => rows.filter(row => row.status !== 'cancelled'
  && row.memberId === memberId && row.planId === planId);
const alignedMonthly = (row: Membership) => row.interval === 'monthly' && ['active', 'pending'].includes(row.status);
function updateIssue(row: Membership, nextDueOn: string) {
  if (!['active', 'pending'].includes(row.status)) return 'immutableMembership';
  return nextDueOn < row.startsOn ? 'beforeStartsOn' : null;
}
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
function matches(person: Person, identity: Identity): boolean {
  return (!identity.email || normalize(person.email ?? '') === identity.email)
    && (!identity.firstName || normalize(person.firstName) === identity.firstName)
    && (!identity.lastName || normalize(person.lastName) === identity.lastName)
    && (!identity.dateOfBirth || person.dateOfBirth === identity.dateOfBirth);
}
const planMatches = (plan: Plan, source: Source) => plan.id === source.plan || normalize(plan.name) === normalize(source.plan);
const key = (memberId: string, planId: string) => JSON.stringify([memberId, planId]);
async function findPeople(tx: Reader, gymId: string, identities: Identity[]): Promise<Person[]> {
  const unique = [...new Map(identities.map(identity => [JSON.stringify(identity.email ? ['email', identity.email]
    : ['name', identity.firstName, identity.lastName]), identity])).values()], people = new Map<string, Person>();
  for (let offset = 0; offset < unique.length; offset += 100) {
    const found = await tx.select().from(members).where(and(eq(members.gymId, gymId), isNull(members.anonymizedAt), or(
      ...unique.slice(offset, offset + 100).map(identity => identity.email ? ilike(members.email, escapeLike(identity.email))
        : and(ilike(members.firstName, escapeLike(identity.firstName)), ilike(members.lastName, escapeLike(identity.lastName)))),
    )));
    for (const person of found) people.set(person.id, person);
  }
  return [...people.values()];
}
// Cache only parsed immutable source data. Every analysis resolves gym-owned references again.
interface SourceIndex { rows: Map<number, Source>; identities: Map<string, Source[]> }
const files = new WeakMap<readonly CsvRow[], Map<string, SourceIndex>>();
const identityKeys = (identity: Identity) => [
  ...(identity.email ? [JSON.stringify(['email', normalize(identity.email)])] : []),
  ...(identity.firstName && identity.lastName ? [JSON.stringify(['name', normalize(identity.firstName), normalize(identity.lastName)])] : []),
];
function sourceFile(context: MapperContext, plan: ImportPlanRequest): SourceIndex {
  const mapping = JSON.stringify(plan.mapping), cache = files.get(context.sourceRows) ?? new Map<string, SourceIndex>();
  files.set(context.sourceRows, cache);
  if (!cache.has(mapping)) {
    const rows = new Map(context.sourceRows.map(row => [row.rowNumber, parseMembership(row, plan)])), identities = new Map<string, Source[]>();
    for (const source of rows.values()) for (const identity of identityKeys(source.identity)) {
      const entries = identities.get(identity) ?? []; entries.push(source); identities.set(identity, entries);
    }
    cache.set(mapping, { rows, identities });
  }
  return cache.get(mapping)!;
}
const scheduleUpdatesSchema = z.array(z.object({ id: idSchema, revision: z.int().positive(), oldDueOn: dateSchema, nextDueOn: dateSchema }));
const committedSchema = z.object({
  memberId: idSchema, householdId: idSchema, planId: idSchema,
  memberRevision: z.int().positive(), householdRevision: z.int().positive(), planRevision: z.int().positive(),
  membershipId: idSchema.nullable(), membershipRevision: z.int().positive().nullable(),
  amountCents: z.int().min(0).max(2147483647), currency: z.string().regex(/^[A-Z]{3}$/),
  interval: z.enum(['monthly', 'annual']), nextDueOn: dateSchema, billingDay: z.int().min(1).max(31).nullable(),
  commitmentEndsOn: dateSchema.nullable(),
  anniversaryOn: dateSchema.nullable(), anniversaryExplicit: z.boolean(),
  scheduleUpdates: z.string().transform(value => scheduleUpdatesSchema.parse(JSON.parse(value))),
});

async function analyze(tx: Reader, rows: readonly CsvRow[], plan: ImportPlanRequest, context: MapperContext): Promise<PlannedRow[]> {
  const file = sourceFile(context, plan), chunk = rows.map(row => file.rows.get(row.rowNumber) ?? parseMembership(row, plan));
  const identities = chunk.filter(source => !source.issues.length).map(source => source.identity);
  const candidates = await findPeople(tx, context.gymId, identities);
  const homeIds = [...new Set(candidates.map(person => person.householdId))];
  const homes = homeIds.length ? await tx.select().from(households).where(and(eq(households.gymId, context.gymId), inArray(households.id, homeIds))) : [];
  // Other family rows can supply an anchor or duplicate in another chunk. Resolve them only in
  // affected households, keeping database reads bounded to this chunk's families.
  const family = homeIds.length ? await tx.select().from(members).where(and(eq(members.gymId, context.gymId),
    inArray(members.householdId, homeIds), isNull(members.anonymizedAt))) : [];
  const catalog = await tx.select().from(plans).where(eq(plans.gymId, context.gymId));
  const existing = homeIds.length ? await tx.select().from(memberships).where(and(eq(memberships.gymId, context.gymId), inArray(memberships.householdId, homeIds))) : [];
  const related = [...new Set(family.flatMap(person => identityKeys({ ...person, email: person.email ?? '', dateOfBirth: person.dateOfBirth ?? '' })
    .flatMap(identity => file.identities.get(identity) ?? [])))].sort((a, b) => a.rowNumber - b.rowNumber);
  // A later row's shared email can also match someone outside these households. Such an
  // ambiguous row must never choose this household's anchor or duplicate its valid row.
  const relatedPeople = await findPeople(tx, context.gymId, related.filter(source => !source.issues.length).map(source => source.identity));
  const resolved = related.filter(source => !source.issues.length).flatMap(source => {
    const people = relatedPeople.filter(person => matches(person, source.identity));
    const selected = catalog.filter(item => planMatches(item, source));
    if (people.length !== 1 || selected.length !== 1 || !selected[0]!.active) return [];
    const member = people[0]!, selectedPlan = selected[0]!;
    if (source.currency && source.currency !== selectedPlan.currency) return [];
    return [{ source, member, plan: selectedPlan, interval: source.interval ?? selectedPlan.interval }];
  });
  const firstRows = new Map<string, (typeof resolved)[number]>();
  for (const item of resolved) if (!firstRows.has(key(item.member.id, item.plan.id))) firstRows.set(key(item.member.id, item.plan.id), item);
  const canonical = [...firstRows.values()];
  return chunk.map(source => {
    const issues = [...source.issues], values: PlannedRow['values'] = { plan: source.plan, nextDueOn: source.nextDueOn };
    const fail = (field: ImportTargetField, code: ImportIssue['code'], name: string, params?: Record<string, string | number>) => issues.push({
      rowNumber: source.rowNumber, column: plan.mapping.find(item => item.targetField === field)?.sourceColumn ?? null, code, message: message(name, params),
    });
    if (!issues.length) {
      const people = candidates.filter(person => matches(person, source.identity)), selected = catalog.filter(item => planMatches(item, source));
      if (people.length !== 1) fail('email', 'unknown_reference', people.length ? 'ambiguousMember' : 'unknownMember');
      if (selected.length !== 1 || !selected[0]!.active) fail('plan', 'unknown_reference', selected.length > 1 ? 'ambiguousPlan' : 'unknownPlan');
      if (!issues.length) {
        const member = people[0]!, selectedPlan = selected[0]!, home = homes.find(item => item.id === member.householdId)!;
        const interval = source.interval ?? selectedPlan.interval;
        const duplicates = livePair(existing, member.id, selectedPlan.id);
        if (source.currency && source.currency !== selectedPlan.currency) fail('currency', 'currency_mismatch', 'currencyMismatch');
        const first = firstRows.get(key(member.id, selectedPlan.id));
        if (first && first.source.rowNumber < source.rowNumber) fail('plan', 'duplicate', 'duplicateRow', { row: first.source.rowNumber });
        if (plan.duplicatePolicy === 'update' && duplicates.length === 1) {
          const problem = updateIssue(duplicates[0]!, source.nextDueOn);
          if (problem) fail(problem === 'beforeStartsOn' ? 'nextDueOn' : 'status', 'conflict', problem);
        }
        const anniversaryOn = interval === 'annual' ? annualAnniversary(source.nextDueOn, source.billingDay) : null;
        if (interval === 'annual' && anniversaryOn === null) fail('billingDay', 'invalid_value', 'invalidAnnualDay');
        let billingDay: number | null = null;
        let scheduleUpdates: z.infer<typeof scheduleUpdatesSchema> = [];
        if (interval === 'monthly' && !issues.length && (!duplicates.length || plan.duplicatePolicy === 'update' && duplicates.length === 1)) {
          const monthly = canonical.filter(item => {
            if (item.member.householdId !== home.id || item.interval !== 'monthly') return false;
            const current = livePair(existing, item.member.id, item.plan.id);
            return !current.length || plan.duplicatePolicy === 'update' && current.length === 1 && !updateIssue(current[0]!, item.source.nextDueOn);
          });
          const explicit = [...new Set(monthly.flatMap(item => item.source.billingDay === null ? [] : [item.source.billingDay]))];
          billingDay = explicit[0] ?? Math.max(...monthly.map(item => Number(item.source.nextDueOn.slice(8))));
          if (!explicit.length && monthly.every(item => householdDateOnOrAfter(item.source.nextDueOn, home.billingDay) === item.source.nextDueOn))
            billingDay = home.billingDay;
          if (explicit.length > 1 || monthly.some(item => householdDateOnOrAfter(item.source.nextDueOn, billingDay!) !== item.source.nextDueOn))
            fail('nextDueOn', 'conflict', 'billingDayConflict');
          if (plan.duplicatePolicy === 'update') scheduleUpdates = monthly.flatMap(item => {
            const current = livePair(existing, item.member.id, item.plan.id);
            return current.length === 1 && alignedMonthly(current[0]!) && !updateIssue(current[0]!, item.source.nextDueOn)
              ? [{ id: current[0]!.id, revision: current[0]!.revision, oldDueOn: current[0]!.nextDueOn, nextDueOn: item.source.nextDueOn }] : [];
          });
          const exempt = new Set(scheduleUpdates.map(update => update.id));
          if (existing.some(item => item.householdId === home.id && alignedMonthly(item)
            && !exempt.has(item.id) && householdDateOnOrAfter(item.nextDueOn, billingDay!) !== item.nextDueOn))
            fail('nextDueOn', 'conflict', 'existingScheduleConflict');
        }
        Object.assign(values, { memberId: member.id, householdId: home.id, planId: selectedPlan.id,
          memberRevision: member.revision, householdRevision: home.revision, planRevision: selectedPlan.revision,
          membershipId: duplicates.length === 1 ? duplicates[0]!.id : null, membershipRevision: duplicates.length === 1 ? duplicates[0]!.revision : null,
          amountCents: source.amountCents ?? selectedPlan.amountCents, currency: selectedPlan.currency, interval,
          billingDay, anniversaryOn, anniversaryExplicit: source.billingDay !== null,
          commitmentEndsOn: source.commitmentEndsOn, scheduleUpdates: JSON.stringify(scheduleUpdates) });
        return { rowNumber: source.rowNumber, values, action: issues.length ? 'error' : 'create', duplicateIds: duplicates.map(item => item.id), issues };
      }
    }
    return { rowNumber: source.rowNumber, values, action: 'error', duplicateIds: [], issues };
  });
}

async function commit(tx: Transaction, rows: readonly PlannedRow[], context: MapperContext): Promise<number> {
  if (rows.length > 100) throw new Error('Membership imports require chunks of at most 100 rows');
  const records = rows.filter(row => !row.issues.length && (row.action === 'create' || row.action === 'update'))
    .map(row => ({ ...committedSchema.parse(row.values), action: row.action }));
  if (!records.length) return 0;
  const { gymId } = context, now = context.clock.now(), today = localDate(now, context.timezone);
  const homeIds = [...new Set(records.map(item => item.householdId))].sort();
  // Match assignment/runner locking: households first. Concurrent imports share these locks.
  const homes = await tx.select().from(households).where(and(eq(households.gymId, gymId), inArray(households.id, homeIds))).orderBy(asc(households.id)).for('update');
  const people = await tx.select().from(members).where(and(eq(members.gymId, gymId), inArray(members.id, [...new Set(records.map(item => item.memberId))])))
    .orderBy(asc(members.id)).for('share');
  const catalog = await tx.select().from(plans).where(and(eq(plans.gymId, gymId), inArray(plans.id, [...new Set(records.map(item => item.planId))])))
    .orderBy(asc(plans.id)).for('share');
  const existing = await tx.select().from(memberships).where(and(eq(memberships.gymId, gymId), inArray(memberships.householdId, homeIds)))
    .orderBy(asc(memberships.id)).for('update');
  for (const item of records) {
    const home = homes.find(row => row.id === item.householdId), person = people.find(row => row.id === item.memberId), selectedPlan = catalog.find(row => row.id === item.planId);
    if (!home || home.revision !== item.householdRevision || !person || person.revision !== item.memberRevision || person.anonymizedAt
      || person.householdId !== home.id || !selectedPlan || selectedPlan.revision !== item.planRevision || !selectedPlan.active || selectedPlan.currency !== item.currency)
      throw new RevisionConflictError();
    if (item.action === 'update') {
      const before = existing.find(row => row.id === item.membershipId);
      if (!before || before.revision !== item.membershipRevision || before.memberId !== person.id || before.planId !== selectedPlan.id
        || updateIssue(before, item.nextDueOn)) throw new RevisionConflictError();
    }
  }
  const audit = (action: string, targetType: string, targetId: string, after: Record<string, unknown>) => writeAudit(tx, {
    gymId, actorKind: context.actor.kind, ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action, targetType, targetId, after: { importId: context.runId, ...after }, occurredAt: now,
  });
  let count = 0;
  const seen = new Set(existing.filter(item => item.status !== 'cancelled').map(item => key(item.memberId, item.planId))), updatedHomes = new Set<string>();
  for (const item of records) {
    const identity = key(item.memberId, item.planId);
    // A replay or another import may already have inserted the same membership after analysis.
    if (item.action === 'create' && seen.has(identity)) continue;
    const home = homes.find(row => row.id === item.householdId)!;
    if (item.billingDay !== null && !updatedHomes.has(home.id)) {
      // Preview and commit use the same eligible monthly updates as exemptions. Validate
      // every reference under the lock before changing the anchor or a dependent schedule.
      for (const update of item.scheduleUpdates) {
        const before = existing.find(row => row.id === update.id);
        if (!before || before.householdId !== home.id || before.revision !== update.revision || before.nextDueOn !== update.oldDueOn
          || !alignedMonthly(before) || updateIssue(before, update.nextDueOn)
          || householdDateOnOrAfter(update.nextDueOn, item.billingDay) !== update.nextDueOn) throw new RevisionConflictError();
      }
      const exempt = new Set(item.scheduleUpdates.map(update => update.id));
      if (existing.some(row => row.householdId === home.id && alignedMonthly(row)
        && !exempt.has(row.id)
        && householdDateOnOrAfter(row.nextDueOn, item.billingDay!) !== row.nextDueOn)) throw new RevisionConflictError();
      if (home.billingDay !== item.billingDay) {
        for (const update of item.scheduleUpdates) {
          // Current-chunk rows apply all their fields below in this same transaction. Move
          // later-chunk dates here so their failure cannot leave an off-anchor membership.
          if (update.nextDueOn === update.oldDueOn || records.some(record => record.action === 'update' && record.membershipId === update.id)) continue;
          const before = existing.find(row => row.id === update.id)!, guard = revisionGuard(memberships.revision, update.revision);
          const after = assertRevised(await tx.update(memberships).set({ nextDueOn: update.nextDueOn, revision: guard.next })
            .where(and(eq(memberships.gymId, gymId), eq(memberships.id, update.id), eq(memberships.nextDueOn, update.oldDueOn), guard.matches)).returning());
          await audit('billing.membership.import_schedule_updated', 'membership', before.id,
            { memberId: before.memberId, planId: before.planId, previousDueOn: update.oldDueOn, nextDueOn: after.nextDueOn });
          Object.assign(before, after);
        }
        const guard = revisionGuard(households.revision, home.revision);
        assertRevised(await tx.update(households).set({ billingDay: item.billingDay, revision: guard.next })
          .where(and(eq(households.gymId, gymId), eq(households.id, home.id), guard.matches)).returning({ id: households.id }));
        await audit('billing.household.anchor_set', 'household', home.id, { billingDay: item.billingDay });
      }
      updatedHomes.add(home.id);
    }
    const before = item.action === 'update' ? existing.find(row => row.id === item.membershipId)! : undefined;
    let anniversaryOn = item.anniversaryOn;
    if (anniversaryOn && !item.anniversaryExplicit && before?.anniversaryOn && before.interval === 'annual'
      && (before.anniversaryOn.slice(5) === item.nextDueOn.slice(5) || before.anniversaryOn.slice(5) === '02-29'
        && item.nextDueOn.slice(5) === '02-28' && !isCalendarDate(item.nextDueOn.slice(0, 4) + '-02-29'))) anniversaryOn = before.anniversaryOn;
    const changes = { amountCents: item.amountCents, currency: item.currency, interval: item.interval, nextDueOn: item.nextDueOn,
      anniversaryOn, ...(item.commitmentEndsOn === null ? {} : { commitmentEndsOn: item.commitmentEndsOn }) };
    let id: string;
    if (before) {
      const guard = revisionGuard(memberships.revision, item.membershipRevision!);
      const after = assertRevised(await tx.update(memberships).set({ ...changes, revision: guard.next })
        .where(and(eq(memberships.gymId, gymId), eq(memberships.id, before.id), guard.matches)).returning());
      id = after.id;
    } else {
      id = uuidv7(now.getTime());
      await tx.insert(memberships).values({ id, gymId, householdId: home.id, memberId: item.memberId, planId: item.planId,
        ...changes, startsOn: item.nextDueOn < today ? item.nextDueOn : today, status: 'active', createdAt: now });
      seen.add(identity);
    }
    await audit(before ? 'billing.membership.import_updated' : 'billing.membership.imported', 'membership', id,
      { memberId: item.memberId, planId: item.planId, nextDueOn: item.nextDueOn, anniversaryOn });
    count++;
  }
  return count;
}

/** Active renewals for existing members and plans, on the durable import pipeline. */
export const membershipsMapper: CsvMapper = { id: 'memberships', available: true, analyze, commit };
