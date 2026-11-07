// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, invoices, paymentAttempts, payments as paymentRows, uuidv7, waiverSignatures, waiverTemplates } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createBillingStanding } from '../../areas/billing/kiosk-standing.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { createSeedCommand } from '../seed-cli.js';
import { billingSeed, seedCalendar } from './billing.js';
import { portalSeed } from './portal.js';
import { studentRows, useUnconfiguredSandbox } from './portal.fixture.test-helper.js';
import { demoSignaturePng } from './waivers-image.js';

const { db, fixture } = useUnconfiguredSandbox();

it('finishes a CLI rerun after a failed current student charge without charging a paid period twice', async () => {
  const { gymId } = db.seeded, f = fixture(true), provider = await f.provider(gymId);
  const { home } = await studentRows(db, gymId);
  const payments = provider.payments;
  if (!(payments instanceof FakePayments)) throw new Error('Expected the test payments fake');
  const confirm = provider.payments.confirmCharge.bind(provider.payments);
  const create = provider.payments.createCharge.bind(provider.payments);
  let fail = true;
  vi.spyOn(provider.payments, 'createCharge').mockImplementation(async input => {
    const result = await create(input);
    const [invoice] = await db.forGym(gymId, tx => tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)));
    if (invoice!.householdId === home.id && fail) payments.respondNextConfirmation('declined');
    return result;
  });
  const confirmations = vi.spyOn(provider.payments, 'confirmCharge').mockImplementation(confirm);
  const io = { stdout: vi.fn(), stderr: vi.fn() }, command = createSeedCommand(db.forGym, f.seed);
  expect(await command.run([gymId], io)).toBe(1);
  const failed = await studentRows(db, gymId);
  expect(failed.invoices.map(row => row.status).sort()).toEqual(['paid', 'paid', 'past_due']);
  const count = confirmations.mock.calls.length;
  fail = false;
  expect(await command.run([gymId], io)).toBe(0);
  const again = await studentRows(db, gymId);
  expect(again.invoices.map(row => row.status)).toEqual(['paid', 'paid', 'paid']);
  expect(again.invoices.map(row => row.id).sort()).toEqual(failed.invoices.map(row => row.id).sort());
  expect(confirmations.mock.calls.length).toBe(count + 1);
  expect(await createBillingStanding(db.forGym).check({ gymId, memberId: again.member.id, clock: f.clock })).toEqual({ status: 'ok' });
  expect(await db.forGym(gymId, tx => tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId,
    failed.invoices.find(row => row.status === 'past_due')!.id)))).toHaveLength(2);
  const dated = await db.forGym(gymId, async tx => ({ attempts: await tx.select().from(paymentAttempts),
    payments: await tx.select().from(paymentRows), audit: await tx.select().from(auditEvents) }));
  expect(dated.attempts.every(row => row.createdAt <= f.clock.now() && (!row.resolvedAt || row.resolvedAt <= f.clock.now()))).toBe(true);
  expect(dated.payments.every(row => row.createdAt <= f.clock.now() && row.paidAt <= f.clock.now())).toBe(true);
  expect(dated.audit.every(row => row.occurredAt <= f.clock.now())).toBe(true);
}, 90_000);

it('reuses one uploaded sample signature after rendering fails before signing', async () => {
  const { gymId } = db.seeded, f = fixture(false), { member } = await studentRows(db, gymId);
  await db.forGym(gymId, tx => tx.delete(waiverSignatures).where(eq(waiverSignatures.memberId, member.id)));
  const uploads = new FakeUploads(gymId, f.clock), render = vi.fn().mockRejectedValueOnce(new Error('Renderer unavailable')).mockResolvedValue(new Uint8Array());
  const step = portalSeed({ scope: db.forGym, clock: f.clock, pinSecret: null, uploadsFor: async () => uploads, render });
  const context = { gymId, timezone: 'UTC', enabledModules: new Set<string>() };
  await expect(step.run(context)).rejects.toThrow('Renderer unavailable');
  const [image] = await uploads.list();
  expect(await uploads.list()).toHaveLength(1);
  await step.run(context);
  expect(await uploads.list()).toHaveLength(1);
  expect((await studentRows(db, gymId)).signatures).toMatchObject([{ signatureImageKey: image!.key }]);
}, 90_000);

it('never reuses a deleted sample signature or one that signed other terms', async () => {
  const { gymId } = db.seeded, f = fixture(false), { member } = await studentRows(db, gymId);
  await db.forGym(gymId, tx => tx.delete(waiverSignatures).where(eq(waiverSignatures.memberId, member.id)));
  const uploads = new FakeUploads(gymId, f.clock), deleted = `${gymId}/waivers/${member.id}/signatures/${uuidv7()}.png`;
  await uploads.put(deleted, demoSignaturePng(), 'image/png');
  await uploads.markDeleted(deleted);
  const options = { scope: db.forGym, clock: f.clock, uploadsFor: async () => uploads, render: async () => new Uint8Array() };
  const step = portalSeed({ ...options, pinSecret: null }), context = { gymId, timezone: 'UTC', enabledModules: new Set<string>() };
  await step.run(context);
  const [first] = (await studentRows(db, gymId)).signatures;
  expect(first!.signatureImageKey).not.toBe(deleted);
  // The seed looks its waiver up by name, so a new template of that name is terms the student hasn't signed.
  await db.forGym(gymId, tx => tx.update(waiverTemplates).set({ name: 'Earlier terms' }).where(eq(waiverTemplates.id, first!.templateId)));
  await createWaiversService(options).createTemplate({ gymId, actor: { kind: 'system' } },
    { name: 'Demo participation waiver', kind: 'waiver', body: 'Newer sample terms for the demo gym.' });
  await step.run(context);
  const keys = (await studentRows(db, gymId)).signatures.map(row => row.signatureImageKey);
  expect(new Set(keys).size).toBe(2);
  expect(keys).not.toContain(deleted);
}, 90_000);

it('records the switch it found when the portal step runs before the billing seed', async () => {
  const { gymId } = db.seeded, f = fixture(true), provider = await f.provider(gymId);
  const context = { gymId, timezone: 'UTC', enabledModules: new Set<string>() };
  await expect(portalSeed({ scope: db.forGym, clock: f.clock, pinSecret: null, uploadsFor: async () => new FakeUploads(gymId, f.clock),
    billingPaymentsFor: async () => provider }).run(context)).rejects.toThrow('Run the billing seed before the portal seed');
  const [marker] = await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.seed.started')));
  expect(marker!.after).toEqual({ billingEnabled: false });
}, 90_000);

it('uses the billing seed anchor when the portal step runs across local midnight', async () => {
  const { gymId } = db.seeded, timezone = 'America/Vancouver', clock = new TestClock('2026-10-27T06:59:00Z'), f = fixture(true, clock);
  await db.forGym(gymId, tx => tx.update(gyms).set({ timezone }).where(eq(gyms.id, gymId)));
  const provider = await f.provider(gymId), context = { gymId, timezone, enabledModules: new Set<string>() };
  await billingSeed({ scope: db.forGym, clock, paymentsFor: async () => provider }).run(context);
  clock.advance(2 * 60_000);
  await portalSeed({ scope: db.forGym, clock, pinSecret: null, uploadsFor: async () => new FakeUploads(gymId, clock),
    billingPaymentsFor: async () => provider }).run(context);
  const [marker] = await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.seed.started')));
  const expected = seedCalendar(marker!.occurredAt, timezone);
  const rows = await studentRows(db, gymId);
  expect(rows.home.billingDay).toBe(expected.billingDay);
  expect(rows.invoices.map(row => row.dueOn).sort()).toEqual([expected.startsOn, expected.previous, expected.dueOn].sort());
  const other = await db.forGym(gymId, tx => tx.select().from(invoices).where(eq(invoices.kind, 'cycle')));
  expect(new Set(other.map(row => row.dueOn))).toEqual(new Set(rows.invoices.map(row => row.dueOn)));
}, 90_000);
