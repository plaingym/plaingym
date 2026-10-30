// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, paymentAttempts, refunds, uuidv7 } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import { restoredBilling as billing } from './restore.billing.test-helper.js';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ source: useTestDatabase(), target: useTestDatabase() }, { shared: true });
const { source, target, clock, gymId } = f;
let base: string;
beforeAll(async () => { base = (await f.prepare(() => f.backup().snapshot())).id; });
const restored = () => billing(f);

describe('restored billing through production restore, jobs and go-live routes', () => {
  it('restores, automatically reconciles the manifest time, then allows an explicit billing enable', async () => {
    await f.restore().restore(base, f.identity);
    const b = await restored(), list = vi.spyOn(b.provider, 'listChangesSince');
    expect((await b.read()).restoreReconciliation).toMatchObject({ snapshotAt: clock.now().toISOString(), checkedAt: null });
    expect((await b.enable()).status).toBe(409);
    expect(await b.queue.runNext()).toBe(true);
    expect(list).toHaveBeenCalledWith(new Date(clock.now().getTime() - 300_000), {});
    expect((await b.read()).restoreReconciliation).toMatchObject({ unresolved: 0, inspected: 0 });
    expect((await b.read()).billingEnabled).toBe(false);
    const make = createFactories(target);
    const refund = await make('refunds', gymId, { status: 'pending' });
    expect((await b.enable()).status).toBe(409);
    await target.forGym(gymId, tx => tx.update(refunds).set({ status: 'succeeded' }).where(eq(refunds.id, refund.id)));
    const attempt = await make('paymentAttempts', gymId, { status: 'pending' });
    expect((await b.enable()).status).toBe(409);
    await target.forGym(gymId, tx => tx.update(paymentAttempts).set({ status: 'failed', resolvedAt: clock.now() }).where(eq(paymentAttempts.id, attempt.id)));
    expect((await b.enable()).status).toBe(200);
    expect((await b.rerun()).status).toBe(409); // Rechecking requires paused billing.
  });
  it('publishes and runs a check for every restored gym', async () => {
    const otherGym = uuidv7(); await f.make('gyms', otherGym, { billingEnabled: true });
    try {
      const snapshot = await f.backup().snapshot(); await f.restore().restore(snapshot.id, f.identity);
      const b = await restored();
      expect(await b.queue.runNext()).toBe(true); expect(await b.queue.runNext()).toBe(true);
      expect(await b.queue.runNext()).toBe(false);
      for (const id of [gymId, otherGym]) {
        const data = await b.service.checklist(id);
        expect(data).toMatchObject({ billingEnabled: false, restoreReconciliation: { unresolved: 0 } });
      }
      const other = (await b.service.checklist(otherGym)).restoreReconciliation!;
      expect((await b.request('/api/settings/go-live/reconciliation', 'POST', {
        revision: (await b.read()).revision, restoreId: other.restoreId,
      })).status).toBe(404);
      expect((await b.request('/api/settings/go-live/reconciliation', 'POST', {
        revision: 999, restoreId: (await b.read()).restoreReconciliation!.restoreId,
      })).status).toBe(409);
    } finally { await source.forSystem(tx => tx.delete(gyms).where(eq(gyms.id, otherGym))); }
  });
  it('keeps unresolved payments blocked, then reruns the production check after resolution', async () => {
    await f.restore().restore(base, f.identity);
    const b = await restored(), invoiceId = uuidv7(), attemptId = uuidv7();
    const charge = await b.provider.createCharge({ amount: 10000, currency: 'usd', customerId: 'cus_test', paymentMethodId: 'pm_test',
      invoiceId, attemptId, idempotencyKey: 'unmatched-restore' });
    await b.provider.confirmCharge(charge.id, { idempotencyKey: 'unmatched-restore:confirm' });
    await b.queue.runNext();
    expect((await b.read()).restoreReconciliation!.unresolved).toBeGreaterThan(0);
    expect((await b.enable()).status).toBe(409);
    const make = createFactories(target), household = await make('households', gymId, { stripeCustomerId: 'cus_test' });
    await make('invoices', gymId, { id: invoiceId, householdId: household.id, status: 'open', number: 1, currency: 'USD', amountCents: 10000 });
    await make('paymentAttempts', gymId, { id: attemptId, invoiceId,
      status: 'pending', paymentIntentId: charge.id, currency: 'USD', createdAt: clock.now() });
    expect((await b.rerun()).status).toBe(200);
    expect((await b.read()).restoreReconciliation).toMatchObject({ unresolved: 0 });
    expect((await b.read()).billingEnabled).toBe(false);
    expect((await b.enable()).status).toBe(200);
    const audits = await target.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.go_live.reconciliation_requested')));
    expect(audits).toHaveLength(1); expect(audits[0]!.actorKind).toBe('user');
  });
});

