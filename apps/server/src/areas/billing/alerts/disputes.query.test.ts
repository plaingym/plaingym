// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- Explain the restore check's dispute query in the disposable test database.
import { sql } from 'drizzle-orm';
import { invoices, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { stripeTestPaymentReference } from '@plaingym/shared/contracts';
import { restorableDisputes } from '../runner/reconciliation.js';
import { testModeDispute, unalertedDisputes } from './disputes.query.js';

const db = useTestDatabase(), factory = createFactories(db);
const gymId = uuidv7();
const ids: Record<'cleared' | 'testPayment' | 'livePayment' | 'allMarked' | 'oneUnmarked', string> =
  { cleared: '', testPayment: '', livePayment: '', allMarked: '', oneUnmarked: '' };
let householdId: string;

async function disputed(name: keyof typeof ids, marked: boolean[]) {
  const disputeId = `dp_${name}`;
  const { id } = await factory('invoices', gymId, { householdId, currency: 'USD', disputeId, disputeStatus: 'open' });
  ids[name] = id;
  const paymentIds: string[] = [];
  for (const test of marked) paymentIds.push((await factory('payments', gymId, { invoiceId: id, currency: 'USD', method: 'card',
    reference: test ? stripeTestPaymentReference : null })).id);
  const audit = (after: Record<string, unknown>, createdAt: string) => factory('auditEvents', gymId, { action: 'billing.invoice.disputed',
    targetType: 'invoice', targetId: id, after: { disputeId, ...after }, occurredAt: new Date(createdAt), createdAt: new Date(createdAt) });
  return { paymentIds, audit };
}

beforeAll(async () => {
  await factory('gyms', gymId);
  ({ id: householdId } = await factory('households', gymId));
  // A switch to live closed it.
  const cleared = await disputed('cleared', [false]);
  await cleared.audit({ paymentId: cleared.paymentIds[0], status: 'open' }, '2028-03-01T00:00:00Z');
  await cleared.audit({ reason: 'stripe_test_cleared', status: 'closed' }, '2028-03-02T00:00:00Z');
  // The latest audit names a payment marked as test.
  const testPayment = await disputed('testPayment', [true, false]);
  await testPayment.audit({ paymentId: testPayment.paymentIds[0] }, '2028-03-01T00:00:00Z');
  // The latest audit names a live payment; an older one and another payment on the invoice are marked.
  const livePayment = await disputed('livePayment', [true, false]);
  await livePayment.audit({ paymentId: livePayment.paymentIds[0] }, '2028-03-01T00:00:00Z');
  await livePayment.audit({ paymentId: livePayment.paymentIds[1] }, '2028-03-02T00:00:00Z');
  // No payment ID recorded, and every payment marked.
  const allMarked = await disputed('allMarked', [true, true]);
  await allMarked.audit({}, '2028-03-01T00:00:00Z');
  // No payment ID recorded, and one payment unmarked.
  const oneUnmarked = await disputed('oneUnmarked', [true, false]);
  await oneUnmarked.audit({}, '2028-03-01T00:00:00Z');
});

const live = () => [ids.livePayment, ids.oneUnmarked].sort();

it('marks the cleared dispute and those on test payments as test-mode, as before', async () => {
  const test = await db.forGym(gymId, tx => tx.select({ id: invoices.id }).from(invoices).where(testModeDispute(tx, gymId)));
  expect(test.map(row => row.id).sort()).toEqual([ids.cleared, ids.testPayment, ids.allMarked].sort());
  const restorable = await db.forGym(gymId, tx => restorableDisputes(tx, gymId));
  expect(restorable.map(row => row.id).sort()).toEqual(live());
  const unalerted = await db.forGym(gymId, tx => unalertedDisputes(tx, gymId));
  expect(unalerted.map(row => row.id).sort()).toEqual(live());
});

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; Plans?: PlanNode[] };
function latestAuditLimits(node: PlanNode): number {
  const own = node['Node Type'] === 'Limit' && node.Plans?.some(function overAudits(child): boolean {
    return child['Relation Name'] === 'audit_events' || !!child.Plans?.some(overAudits);
  }) ? 1 : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + latestAuditLimits(child), 0);
}

it('reads the latest dispute audit once per invoice in the restore check\'s query', async () => {
  const plan = await db.forGym(gymId, async tx => {
    // eslint-disable-next-line database/system-tables -- Explain the query the restore check runs.
    const [row] = await tx.execute<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(sql`explain (format json) ${restorableDisputes(tx, gymId).getSQL()}`);
    return row!['QUERY PLAN'][0]!.Plan;
  });
  expect(latestAuditLimits(plan)).toBe(1);
});
