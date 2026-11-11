// SPDX-License-Identifier: AGPL-3.0-only
import { attendances, auditEvents, classSessionPrograms, classSessions, households, invoiceLineItems, invoices,
  members, memberships, payments, refunds, uuidv7, type forGym } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import { addDays, zonedInstant } from '@plaingym/shared/time';

const timezone = 'America/New_York';
const at = (date: string, time = '00:00') => zonedInstant(date, time, timezone, { gap: 'shift' })!;
const month = (number: number) => `2025-${String(number).padStart(2, '0')}-01`;
const nextMonth = (number: number) => number === 12 ? '2026-01-01' : month(number + 1);

/** A deterministic year of a full gym, using app-role bulk inserts in short, bounded transactions. */
export async function buildFullReportGym(database: { forGym: typeof forGym }, currency: 'USD' | 'JPY') {
  const gymId = uuidv7(), factory = createFactories(database);
  await factory('gyms', gymId, { name: `${currency} report fixture`, timezone, currency });
  const program = await factory('programs', gymId, { name: `${currency} program` });
  const plan = await factory('plans', gymId, { name: `${currency} monthly`, amountCents: 10000 });
  const tax = await factory('taxRates', gymId, { name: `${currency} tax`, rateMillionths: 100000 });
  const people = Array.from({ length: 300 }, (_, index) => ({ index, householdId: uuidv7(), memberId: uuidv7(), membershipId: uuidv7() }));
  // A June freeze resumes in July; another cohort is still frozen in December. Thirty cancel in October.
  const cancelled = (index: number) => index % 10 === 0;
  const frozen = (index: number, date: string) => index % 10 === 1 && date >= month(6) && date < month(7)
    || index % 10 === 2 && date >= month(12);
  const live = (index: number, date: string) => !cancelled(index) || date < month(10);

  async function batches<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
    for (let offset = 0; offset < rows.length; offset += 500) await insert(rows.slice(offset, offset + 500));
  }
  await batches(people.map(person => ({ id: person.householdId, gymId, name: `${currency} household ${person.index}` })),
    chunk => database.forGym(gymId, tx => tx.insert(households).values(chunk)));
  await batches(people.map(person => ({ id: person.memberId, gymId, householdId: person.householdId,
    firstName: 'Synthetic', lastName: `${currency} ${person.index}`, status: cancelled(person.index) ? 'cancelled' : 'active' })),
    chunk => database.forGym(gymId, tx => tx.insert(members).values(chunk)));
  await batches(people.map(person => ({ id: person.membershipId, gymId, householdId: person.householdId, memberId: person.memberId,
    planId: plan.id, currency, amountCents: 10000, interval: 'monthly', startsOn: month(1), nextDueOn: '2026-01-01',
    status: cancelled(person.index) ? 'cancelled' : person.index % 10 === 2 ? 'frozen' : 'active',
    cancelledAt: cancelled(person.index) ? at(month(10)) : null, frozenAt: person.index % 10 === 2 ? at(month(12)) : null })),
    chunk => database.forGym(gymId, tx => tx.insert(memberships).values(chunk)));

  const events: (typeof auditEvents.$inferInsert)[] = [];
  for (const person of people) {
    const imported = person.index % 10 === 3;
    const event = (action: string, date: string, before: Record<string, unknown> | null, after: Record<string, unknown>) => {
      events.push({ id: uuidv7(), gymId, actorKind: 'system', action: `billing.membership.${action}`, targetType: 'membership',
        targetId: person.membershipId, occurredAt: at(date), before, after });
    };
    event(imported ? 'imported' : 'assigned', month(1), null, imported
      ? { memberId: person.memberId, planId: plan.id } : { membership: { id: person.membershipId, status: 'active' } });
    if (person.index % 10 === 1) {
      event('frozen', month(6), { status: 'active' }, { status: 'frozen' });
      event('activated', month(7), { status: 'frozen' }, { status: 'active' });
    }
    if (person.index % 10 === 2) event('frozen', month(12), { status: 'active' }, { status: 'frozen' });
    if (cancelled(person.index)) event('cancelled', month(10), { status: 'active' }, { status: 'cancelled' });
  }
  const bills: (typeof invoices.$inferInsert)[] = [], lines: (typeof invoiceLineItems.$inferInsert)[] = [];
  const receipts: (typeof payments.$inferInsert)[] = [], returns: (typeof refunds.$inferInsert)[] = [];
  for (let period = 1; period <= 12; period++) for (const person of people) {
    const date = month(period);
    if (!live(person.index, date) || frozen(person.index, date)) continue;
    const invoiceId = uuidv7(), paymentId = uuidv7(), paidAt = at(date, '12:00');
    const refunded = (person.index + period) % 20 === 0;
    bills.push({ id: invoiceId, gymId, householdId: person.householdId, currency, kind: 'cycle',
      status: refunded ? 'partially_refunded' : 'paid', number: bills.length + 1, dueOn: date,
      periodStartsOn: date, periodEndsOn: nextMonth(period), amountCents: 11000, paidAt });
    lines.push({ id: uuidv7(), gymId, householdId: person.householdId, invoiceId, currency, membershipId: person.membershipId,
      kind: 'membership', description: 'Monthly membership', amountCents: 10000 },
    { id: uuidv7(), gymId, householdId: person.householdId, invoiceId, currency,
      kind: 'tax', description: 'Tax', taxRateId: tax.id, taxRateMillionths: 100000, taxInclusive: false, amountCents: 1000 });
    receipts.push({ id: paymentId, gymId, invoiceId, currency, method: 'cash', amountCents: 11000, paidAt });
    events.push({ id: uuidv7(), gymId, actorKind: 'system', action: 'billing.payment.recorded', targetType: 'payment',
      targetId: paymentId, occurredAt: paidAt, after: { accepted: true } });
    if (refunded) returns.push({ id: uuidv7(), gymId, paymentId, currency, status: 'succeeded', amountCents: 1100,
      resolvedAt: at(addDays(date, 14), '12:00') });
  }
  await batches(bills, chunk => database.forGym(gymId, tx => tx.insert(invoices).values(chunk)));
  await batches(lines, chunk => database.forGym(gymId, tx => tx.insert(invoiceLineItems).values(chunk)));
  await batches(receipts, chunk => database.forGym(gymId, tx => tx.insert(payments).values(chunk)));
  await batches(returns, chunk => database.forGym(gymId, tx => tx.insert(refunds).values(chunk)));
  await batches(events, chunk => database.forGym(gymId, tx => tx.insert(auditEvents).values(chunk)));

  const sessions: (typeof classSessions.$inferInsert)[] = [], visits: (typeof attendances.$inferInsert)[] = [];
  // Monday, Wednesday and Friday for 52 weeks, with no visits while frozen or after cancellation.
  for (let week = 0; week < 52; week++) for (const weekday of [0, 2, 4]) {
    const date = addDays('2025-01-06', week * 7 + weekday);
    if (date >= '2026-01-01') continue;
    const sessionId = uuidv7(), occurredAt = at(date, '18:00');
    sessions.push({ id: sessionId, gymId, name: 'Synthetic class', startsAt: at(date, '18:00'), endsAt: at(date, '19:00') });
    for (const person of people) if (live(person.index, date) && !frozen(person.index, date)) {
      visits.push({ id: uuidv7(), gymId, memberId: person.memberId, sessionId, programId: program.id,
        occurredAt, source: 'coach' });
    }
  }
  await batches(sessions, chunk => database.forGym(gymId, tx => tx.insert(classSessions).values(chunk)));
  await batches(sessions.map(session => ({ gymId, sessionId: session.id!, programId: program.id })),
    chunk => database.forGym(gymId, tx => tx.insert(classSessionPrograms).values(chunk)));
  await batches(visits, chunk => database.forGym(gymId, tx => tx.insert(attendances).values(chunk)));
  return { gymId, timezone, currency, programId: program.id,
    memberIds: new Set(people.map(person => person.memberId)), membershipIds: new Set(people.map(person => person.membershipId)),
    counts: { households: people.length, members: people.length, memberships: people.length, invoices: bills.length,
      invoiceLines: lines.length, payments: receipts.length, refunds: returns.length, auditEvents: events.length,
      sessions: sessions.length, attendances: visits.length } };
}
