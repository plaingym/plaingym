// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MutationContext } from './common.js';
import type { CardSuccess, InvoiceEffect, InvoiceFixture, InvoiceTransitions, ManualPayment, ProcessorRefundTransition, RefundTransition } from './invoice-transitions.js';
import type { Refund } from '../../infra/payments/index.js';

export type RefundProvenance = 'tagged' | 'requested' | 'duplicate' | 'original' | 'external';

export interface InvoiceTransitionsHarness {
  transitions: InvoiceTransitions;
  context: MutationContext;
  /** A card success for the seeded pending attempt of a cycle invoice, for the invoice's full amount. */
  success: CardSuccess & { attemptId: string };
  /** A cash payment of the same invoice, for the full amount. */
  manual: ManualPayment;
  seedRefund(request: RefundTransition, provenance: RefundProvenance): Promise<void>;
  /** Moves the harness clock forward, so a release can cross or stay inside the refund window. */
  advance(milliseconds: number): void;
  /** A staff user's context in the harness gym; without it, a user actor with a fresh ID (enough for the fake). */
  staff?(): Promise<MutationContext>;
  read(): Promise<{ invoice: string; attempt: { status: string; declineCode: string | null }; effects: InvoiceEffect['kind'][];
    refunds: RefundTransition[] }>;
}

/** Both the fake and the real transitions run these cases, so the fake can't drift from cancellation or refund rules. */
export function invoiceTransitionsContract(name: string, create: (options?: { packSale?: boolean;
  checkout?: Pick<InvoiceFixture, 'checkoutSessionId' | 'checkoutExpiresAt'> }) => Promise<InvoiceTransitionsHarness>) {
  describe(name + ': cancellations and refund reversals', () => {
    const count = (effects: readonly string[], kind: InvoiceEffect['kind']) => effects.filter((effect) => effect === kind).length;
    const processor = (h: InvoiceTransitionsHarness, value: Partial<Refund> = {}, pendingRefunds: Refund[] = []): ProcessorRefundTransition => ({
      invoiceId: h.success.invoiceId, paymentId: h.success.paymentId, refundId: randomUUID(), pendingRefunds,
      processorRefund: { id: 're_contract_processor', chargeId: h.success.paymentIntentId, amount: h.success.amountCents,
        currency: h.success.currency.toLowerCase(), status: 'succeeded', metadata: { gymId: h.context.gymId }, ...value },
    });
    const reservation = (h: InvoiceTransitionsHarness, amountCents = h.success.amountCents): RefundTransition => ({
      invoiceId: h.success.invoiceId, paymentId: h.success.paymentId, refundId: randomUUID(), amountCents,
      currency: h.success.currency, status: 'pending', tagged: true,
    });
    it('requires the named processor transition in the interface', () => {
      expectTypeOf<ProcessorRefundTransition>().not.toExtend<Parameters<InvoiceTransitions['refund']>[1]>();
      expectTypeOf<Parameters<InvoiceTransitions['processorRefund']>[1]>().toEqualTypeOf<ProcessorRefundTransition>();
    });
    for (const tagged of [false, true]) it.each(['pending', 'succeeded', 'failed', 'canceled'] as const)(
      `matches the app reservation with tagged=${tagged} when the processor reports %s`, async status => {
        const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
        const own = { ...reservation(h), tagged };
        await h.transitions.refund(h.context, own);
        const report = processor(h, { status, ...(tagged ? { reservationId: own.refundId } : {}) });
        expect((await h.transitions.processorRefund(h.context, report)).outcome).toBe('applied');
        const after = await h.read();
        expect(after.refunds).toHaveLength(1);
        expect(after.refunds[0]).toMatchObject({ refundId: own.refundId, processorId: report.processorRefund.id, status });
        expect(after.invoice).toBe(status === 'succeeded' ? 'refunded' : 'paid');
        expect(count(after.effects, 'staff_notice')).toBe(status === 'failed' || status === 'canceled' ? 1 : 0);
        expect((await h.transitions.processorRefund(h.context, { ...report, refundId: randomUUID() })).outcome).toBe('ignored');
        expect(await h.read()).toEqual(after);
      });
    it('matches the named tagged reservation among otherwise identical pending reservations', async () => {
      const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
      const first = reservation(h, 5000), own = reservation(h, 5000);
      await h.transitions.refund(h.context, first); await h.transitions.refund(h.context, own);
      await h.transitions.processorRefund(h.context, processor(h, { amount: 5000, reservationId: own.refundId }));
      const after = await h.read();
      expect(after.refunds).toHaveLength(2);
      expect(after.refunds.find(row => row.refundId === first.refundId)?.status).toBe('pending');
      expect(after.refunds.find(row => row.refundId === own.refundId)).toMatchObject({ status: 'succeeded', processorId: 're_contract_processor' });
    });
    it.each(['tagged', 'requested', 'duplicate', 'original', 'external'] as const)(
      'uses %s provenance when canceling an already linked processor refund', async provenance => {
        const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
        const own = { ...reservation(h), processorId: 're_contract_processor', tagged: false };
        await h.seedRefund(own, provenance);
        const report = processor(h, { status: 'canceled' });
        await h.transitions.processorRefund(h.context, report);
        await h.transitions.processorRefund(h.context, { ...report, refundId: randomUUID() });
        const after = await h.read();
        expect(after.refunds).toHaveLength(1);
        expect(after.refunds[0]).toMatchObject({ refundId: own.refundId, status: 'canceled' });
        expect(count(after.effects, 'staff_notice')).toBe(provenance === 'external' ? 0 : 1);
      });
    it('refuses ambiguous legacy reservations without releasing or recording anything', async () => {
      const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
      const own = { ...reservation(h, 2000), tagged: false };
      await h.transitions.refund(h.context, own);
      await h.transitions.refund(h.context, { ...own, refundId: randomUUID() });
      const before = await h.read();
      await expect(h.transitions.processorRefund(h.context, processor(h, { amount: 2000 }))).rejects.toThrow('Refund reservation is ambiguous');
      expect(await h.read()).toEqual(before);
    });
    it.each(['missing', 'amount', 'currency', 'gym', 'payment'] as const)(
      'records an external refund that fits while another pending read has a %s mismatch', async mismatch => {
        const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
        const unread = { ...reservation(h, 2000), processorId: 're_unreadable' };
        await h.transitions.refund(h.context, unread);
        const unsent = reservation(h, 3000); await h.transitions.refund(h.context, unsent);
        const read = processor(h, { id: unread.processorId, amount: mismatch === 'amount' ? 1000 : 2000, status: 'failed',
          ...(mismatch === 'currency' ? { currency: 'usd' } : {}),
          ...(mismatch === 'gym' ? { metadata: { gymId: randomUUID() } } : {}),
          ...(mismatch === 'payment' ? { chargeId: 'pi_unrelated' } : {}),
        }).processorRefund;
        const report = processor(h, { amount: 5000 }, mismatch === 'missing' ? [] : [read]);
        await h.transitions.processorRefund(h.context, report);
        const after = await h.read();
        expect(after.refunds).toHaveLength(3);
        expect(after.refunds.find(row => row.refundId === unread.refundId)?.status).toBe('pending');
        expect(after.refunds.find(row => row.refundId === unsent.refundId)?.status).toBe('pending');
        expect(after.refunds.find(row => row.refundId === report.refundId)?.status).toBe('succeeded');
        expect(after.invoice).toBe('partially_refunded');
      });
    it('rolls back a refreshed refund when an unread row would force releasing an unsent reservation', async () => {
      const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
      const unread = { ...reservation(h, 2000), processorId: 're_unreadable' };
      const refreshed = { ...reservation(h, 3000), processorId: 're_refresh' };
      await h.transitions.refund(h.context, unread); await h.transitions.refund(h.context, refreshed);
      await h.transitions.refund(h.context, reservation(h, 5000));
      const before = await h.read();
      const read = processor(h, { id: refreshed.processorId, amount: 3000, status: 'failed' }).processorRefund;
      await expect(h.transitions.processorRefund(h.context, processor(h, { amount: 4000 }, [read])))
        .rejects.toMatchObject({ code: 'conflict' });
      expect(await h.read()).toEqual(before);
    });
    it('refreshes a failed processor refund and preserves an unsent reservation when the external amount then fits', async () => {
      const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
      const refreshed = { ...reservation(h, 6000), processorId: 're_refresh' };
      const unsent = reservation(h, 3000);
      await h.transitions.refund(h.context, refreshed); await h.transitions.refund(h.context, unsent);
      const read = processor(h, { id: refreshed.processorId, amount: 6000, status: 'failed' }).processorRefund;
      await h.transitions.processorRefund(h.context, processor(h, { amount: 3000 }, [read]));
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === refreshed.refundId)?.status).toBe('failed');
      expect(after.refunds.find(row => row.refundId === unsent.refundId)?.status).toBe('pending');
      expect(count(after.effects, 'staff_notice')).toBe(1);
    });
    it('releases only the newest unsent reservation needed for an external refund', async () => {
      const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
      // Both use the same clock instant, so IDs break the tie deterministically.
      const [firstId, secondId] = [randomUUID(), randomUUID()].sort();
      const first = { ...reservation(h, 4000), refundId: firstId! }, second = { ...reservation(h, 6000), refundId: secondId! };
      await h.transitions.refund(h.context, first); await h.transitions.refund(h.context, second);
      const report = processor(h, { amount: 3000 });
      await h.transitions.processorRefund(h.context, report);
      const after = await h.read();
      expect(after.refunds).toHaveLength(3);
      expect(after.refunds.find(row => row.refundId === first.refundId)?.status).toBe('pending');
      expect(after.refunds.find(row => row.refundId === second.refundId)?.status).toBe('failed');
      expect(after.refunds.find(row => row.refundId === report.refundId)?.status).toBe('succeeded');
    });
    it('refuses a processor refund in another gym without changing its reservations', async () => {
      const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
      const own = reservation(h); await h.transitions.refund(h.context, own);
      const before = await h.read();
      await expect(h.transitions.processorRefund({ ...h.context, gymId: randomUUID() }, processor(h, { reservationId: own.refundId })))
        .rejects.toMatchObject({ code: 'not_found' });
      expect(await h.read()).toEqual(before);
    });
    const refuse = async (h: InvoiceTransitionsHarness, value: Partial<Refund>) => {
      await h.transitions.cardSucceeded(h.context, h.success);
      const own = reservation(h);
      await h.seedRefund(own, 'tagged');
      const before = await h.read();
      await expect(h.transitions.processorRefund({ ...h.context, actor: { kind: 'system' } }, processor(h, value)))
        .rejects.toMatchObject({ code: 'not_found' });
      expect(await h.read()).toEqual(before);
    };
    it('refuses a processor refund whose gym metadata is another gym and releases nothing', async () => {
      await refuse(await create(), { metadata: { gymId: randomUUID() } });
    });
    it('refuses a processor refund whose charge is not the payment\'s and releases nothing', async () => {
      await refuse(await create(), { chargeId: 'ch_other' });
    });
    it('refuses a processor refund whose currency is not the payment\'s and releases nothing', async () => {
      const h = await create();
      await refuse(h, { currency: h.success.currency === 'EUR' ? 'usd' : 'eur' });
    });
    const release = async (h: InvoiceTransitionsHarness, provenance: RefundProvenance, advance: number) => {
      await h.transitions.cardSucceeded(h.context, h.success);
      const own = reservation(h);
      await h.seedRefund(own, provenance);
      h.advance(advance);
      const before = await h.read();
      await h.transitions.processorRefund({ ...h.context, actor: { kind: 'system' } }, processor(h));
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === own.refundId)?.status).toBe('failed');
      return { before, after };
    };
    it('notices a system release past the refund window exactly once', async () => {
      const { before, after } = await release(await create(), 'tagged', 24 * 3600_000);
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice') + 1);
    });
    it('notices a released duplicate reservation exactly once inside the window', async () => {
      const { before, after } = await release(await create(), 'duplicate', 3600_000);
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice') + 1);
    });
    it('does not notice a system release inside the refund window', async () => {
      const { before, after } = await release(await create(), 'tagged', 3600_000);
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice'));
    });
    it.each([
      ['notices a lapsed reservation the system releases through plain refund', 'tagged', 24 * 3600_000, true, 1],
      ['notices a duplicate reservation the system releases through plain refund', 'duplicate', 3600_000, true, 1],
      ['does not notice a plain system release inside the refund window', 'tagged', 3600_000, true, 0],
      ['does not notice a lapsed reservation that staff release through plain refund', 'tagged', 24 * 3600_000, false, 0],
    ] as const)('%s', async (_name, provenance, advance, systemActor, notices) => {
      const h = await create(); await h.transitions.cardSucceeded(h.context, h.success);
      const own = reservation(h);
      await h.seedRefund(own, provenance);
      h.advance(advance);
      const before = await h.read();
      const context: MutationContext = systemActor ? { ...h.context, actor: { kind: 'system' } }
        : await h.staff?.() ?? { ...h.context, actor: { kind: 'user', userId: randomUUID() } };
      expect((await h.transitions.refund(context, { ...own, status: 'failed' })).outcome).toBe('applied');
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === own.refundId)?.status).toBe('failed');
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice') + notices);
    });
    const missingRow = async (h: InvoiceTransitionsHarness) => {
      await h.transitions.cardSucceeded(h.context, h.success);
      const missing = { ...reservation(h, 2000), processorId: 're_missing' };
      await h.transitions.refund(h.context, missing);
      return missing;
    };
    it('releases a pending refund the processor reports missing when an external refund needs its room', async () => {
      const h = await create(), missing = await missingRow(h);
      const before = await h.read();
      const report = { ...processor(h, { amount: 9000 }), missingRefunds: ['re_missing'] };
      expect((await h.transitions.processorRefund(h.context, report)).outcome).toBe('applied');
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === missing.refundId)?.status).toBe('failed');
      expect(after.refunds.find(row => row.refundId === report.refundId)?.status).toBe('succeeded');
      expect(after.invoice).toBe('partially_refunded');
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice') + 1);
      expect((await h.transitions.processorRefund(h.context, report)).outcome).toBe('ignored');
      expect(await h.read()).toEqual(after);
    });
    const succeeded = (rows: readonly RefundTransition[]) =>
      rows.filter(row => row.status === 'succeeded').reduce((sum, row) => sum + row.amountCents, 0);
    it('notifies staff once for a later success and once for a subsequent failure on a refund released as missing', async () => {
      const h = await create(), missing = await missingRow(h);
      await h.transitions.processorRefund(h.context, { ...processor(h, { amount: 9000 }), missingRefunds: ['re_missing'] });
      const before = await h.read();
      const found = processor(h, { id: 're_missing', amount: 2000 });
      expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === missing.refundId)?.status).toBe('failed');
      expect(after.invoice).toBe('partially_refunded');
      expect(succeeded(after.refunds)).toBe(9000);
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice') + 1);
      expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
      expect(await h.read()).toEqual(after);

      const failed = { ...found, processorRefund: { ...found.processorRefund, status: 'failed' as const } };
      expect((await h.transitions.processorRefund(h.context, failed)).outcome).toBe('ignored');
      const afterFailure = await h.read();
      expect(afterFailure).toEqual({ ...after, effects: [...after.effects, 'staff_notice'].sort() });
      expect((await h.transitions.processorRefund(h.context, failed)).outcome).toBe('ignored');
      expect(await h.read()).toEqual(afterFailure);
    });
    it('notifies staff when a separate refund carries a failed read for a found refund', async () => {
      const h = await create(), missing = await missingRow(h);
      await h.transitions.processorRefund(h.context, { ...processor(h, { amount: 9000 }), missingRefunds: ['re_missing'] });
      const found = processor(h, { id: 're_missing', amount: 2000 });
      expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
      const before = await h.read();
      const failed = processor(h, { id: 're_missing', amount: 2000, status: 'failed' }).processorRefund;
      const separate = processor(h, { id: 're_separate', amount: 1000 }, [failed]);
      expect((await h.transitions.processorRefund(h.context, separate)).outcome).toBe('applied');
      const after = await h.read();
      expect(after.refunds.filter(row => row.processorId === 're_separate')).toEqual([
        expect.objectContaining({ refundId: separate.refundId, status: 'succeeded', amountCents: 1000 }),
      ]);
      expect(after.refunds.find(row => row.refundId === missing.refundId)?.status).toBe('failed');
      expect(after.invoice).toBe('refunded');
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice') + 1);
      expect((await h.transitions.processorRefund(h.context, separate)).outcome).toBe('ignored');
      expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
      expect(await h.read()).toEqual(after);
    });
    // `failed` is reported before any success; `canceled` is reported after a success.
    it.each(['failed', 'canceled'] as const)(
      'adds no staff follow-up for a %s report on a refund released as missing (failure before success, cancellation after success)', async status => {
        const h = await create(), missing = await missingRow(h);
        await h.transitions.processorRefund(h.context, { ...processor(h, { amount: 9000 }), missingRefunds: [missing.processorId] });
        const found = processor(h, { id: missing.processorId, amount: missing.amountCents });
        if (status === 'canceled') expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
        const before = await h.read();
        const report = { ...found, processorRefund: { ...found.processorRefund, status } };
        expect((await h.transitions.processorRefund(h.context, report)).outcome).toBe('ignored');
        expect(await h.read()).toEqual(before);
      });
    // A 9000 external refund releases the 2000 pending refund as missing, with one staff notice for the release.
    const released = async (h: InvoiceTransitionsHarness) => {
      const missing = await missingRow(h), initial = await h.read();
      await h.transitions.processorRefund(h.context, { ...processor(h, { amount: 9000 }), missingRefunds: [missing.processorId] });
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === missing.refundId)?.status).toBe('failed');
      expect(count(after.effects, 'staff_notice')).toBe(count(initial.effects, 'staff_notice') + 1);
      const found = processor(h, { id: missing.processorId, amount: missing.amountCents });
      return { after, found, failedRead: { ...found.processorRefund, status: 'failed' as const } };
    };
    it('ignores a stale success after a verified failure on a refund released as missing, and replays of both', async () => {
      const h = await create();
      expect(h.success.amountCents).toBe(10000);
      const { after, found, failedRead } = await released(h);
      const failed = { ...found, processorRefund: failedRead };
      expect((await h.transitions.processorRefund(h.context, failed)).outcome).toBe('ignored');
      expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
      expect(await h.read()).toEqual(after);
      for (const report of [failed, found]) expect((await h.transitions.processorRefund(h.context, report)).outcome).toBe('ignored');
      expect(await h.read()).toEqual(after);
    });
    it.each(['new', 'already recorded'] as const)(
      'treats a matching failed read supplied with a %s separate refund as a verified failure of a refund released as missing',
      async primary => {
        const h = await create(), { after: release, found, failedRead } = await released(h);
        const separate = processor(h, { id: 're_contract_separate', amount: 1000 });
        const withRead = { ...separate, pendingRefunds: [failedRead] };
        if (primary === 'already recorded') await h.transitions.processorRefund(h.context, separate);
        expect((await h.transitions.processorRefund(h.context, withRead)).outcome).toBe(primary === 'new' ? 'applied' : 'ignored');
        const after = await h.read();
        expect(after.refunds.filter(row => row.processorId === separate.processorRefund.id)).toHaveLength(1);
        expect(succeeded(after.refunds)).toBe(10000);
        expect(after.invoice).toBe('refunded');
        expect(count(after.effects, 'staff_notice')).toBe(count(release.effects, 'staff_notice'));
        for (const report of [found, withRead, found])
          expect((await h.transitions.processorRefund(h.context, report)).outcome).toBe('ignored');
        expect(await h.read()).toEqual(after);
      });
    it.each(['a mismatched amount', 'a mismatched currency', 'a mismatched gym', 'a mismatched charge', 'a canceled status',
      'a rolled-back report'] as const)(
      'keeps a later success on a refund released as missing eligible for its notice after a failed read with %s', async variant => {
        const h = await create(), { found, failedRead } = await released(h);
        const changes: Record<typeof variant, Partial<Refund>> = {
          'a mismatched amount': { amount: 1500 },
          'a mismatched currency': { currency: h.success.currency.toLowerCase() === 'eur' ? 'usd' : 'eur' },
          'a mismatched gym': { metadata: { gymId: randomUUID() } },
          'a mismatched charge': { chargeId: 'ch_contract_other' },
          'a canceled status': { status: 'canceled' },
          'a rolled-back report': {},
        };
        // 2000 more than the remaining 1000 can't fit, so that report is refused and rolls back with its read.
        const separate = { ...processor(h, { id: 're_contract_separate', amount: variant === 'a rolled-back report' ? 2000 : 1000 }),
          pendingRefunds: [{ ...failedRead, ...changes[variant] }] };
        if (variant === 'a rolled-back report')
          await expect(h.transitions.processorRefund(h.context, separate)).rejects.toMatchObject({ code: 'conflict' });
        else expect((await h.transitions.processorRefund(h.context, separate)).outcome).toBe('applied');
        const before = await h.read();
        expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
        const after = await h.read();
        expect(after).toEqual({ ...before, effects: [...before.effects, 'staff_notice'].sort() });
        expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
        expect(await h.read()).toEqual(after);
      });
    it('records a later success for a refund released as missing once after the external refund that released it is canceled', async () => {
      const h = await create(), missing = await missingRow(h);
      const report = { ...processor(h, { amount: 9000, status: 'pending' }), missingRefunds: ['re_missing'] };
      await h.transitions.processorRefund(h.context, report);
      expect((await h.read()).refunds.find(row => row.refundId === missing.refundId)?.status).toBe('failed');
      await h.transitions.processorRefund(h.context, { ...report, processorRefund: { ...report.processorRefund, status: 'canceled' } });
      const before = await h.read();
      const found = processor(h, { id: 're_missing', amount: 2000 });
      expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === missing.refundId)?.status).toBe('failed');
      expect(after.invoice).toBe('paid');
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice') + 1);
      expect((await h.transitions.processorRefund(h.context, found)).outcome).toBe('ignored');
      expect(await h.read()).toEqual(after);
    });
    it('keeps a missing pending refund that an external refund fits beside', async () => {
      const h = await create(), missing = await missingRow(h);
      const before = await h.read();
      const report = { ...processor(h, { amount: 8000 }), missingRefunds: ['re_missing'] };
      await h.transitions.processorRefund(h.context, report);
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === missing.refundId)?.status).toBe('pending');
      expect(after.refunds.find(row => row.refundId === report.refundId)?.status).toBe('succeeded');
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice'));
    });
    it('still refuses an external refund that needs an unread row\'s room when the row is not reported missing', async () => {
      const h = await create(); await missingRow(h);
      const before = await h.read();
      await expect(h.transitions.processorRefund(h.context, processor(h, { amount: 9000 }))).rejects.toMatchObject({ code: 'conflict' });
      expect(await h.read()).toEqual(before);
    });
    it('releases a missing pending refund before an unsent reservation', async () => {
      const h = await create(), missing = await missingRow(h);
      const unsent = reservation(h, 3000); await h.transitions.refund(h.context, unsent);
      const report = { ...processor(h, { amount: 9000 }), missingRefunds: ['re_missing'] };
      await h.transitions.processorRefund(h.context, report);
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === missing.refundId)?.status).toBe('failed');
      expect(after.refunds.find(row => row.refundId === unsent.refundId)?.status).toBe('failed');
      expect(after.refunds.find(row => row.refundId === report.refundId)?.status).toBe('succeeded');
    });
    it('releases only the newest missing refund when it alone makes room, preserving a newer unsent reservation', async () => {
      const h = await create(), older = await missingRow(h);
      h.advance(1000);
      const newer = { ...reservation(h, 2000), processorId: 're_missing_newer' };
      await h.transitions.refund(h.context, newer);
      h.advance(1000);
      const unsent = reservation(h, 3000);
      await h.transitions.refund(h.context, unsent);

      const before = await h.read();
      const report = { ...processor(h, { amount: 5000 }), missingRefunds: [older.processorId, newer.processorId] };
      await h.transitions.processorRefund(h.context, report);
      const after = await h.read();
      expect(after.refunds.find(row => row.refundId === older.refundId)?.status).toBe('pending');
      expect(after.refunds.find(row => row.refundId === newer.refundId)?.status).toBe('failed');
      expect(after.refunds.find(row => row.refundId === unsent.refundId)?.status).toBe('pending');
      expect(after.refunds.find(row => row.refundId === report.refundId)?.status).toBe('succeeded');
      expect(count(after.effects, 'staff_notice')).toBe(count(before.effects, 'staff_notice') + 1);
    });
    it('treats a missing pending refund with a mismatched read as unread', async () => {
      const h = await create(), missing = await missingRow(h);
      const before = await h.read();
      const read = processor(h, { id: missing.processorId, amount: 1000, status: 'pending' }).processorRefund;
      const report = { ...processor(h, { amount: 9000 }, [read]), missingRefunds: ['re_missing'] };
      await expect(h.transitions.processorRefund(h.context, report)).rejects.toMatchObject({ code: 'conflict' });
      expect(await h.read()).toEqual(before);
    });
    it('refuses an unresolved attempt, then voids a failed invoice and refunds a late success once', async () => {
      const h = await create(), { invoiceId, attemptId, paymentIntentId } = h.success;
      const request = { invoiceId, reason: 'Invoice issued in error' };
      await expect(h.transitions.voidInvoice(h.context, request)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['pending_attempt'] } });
      await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'requires_action' });
      await expect(h.transitions.voidInvoice(h.context, request)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['action_required'] } });
      await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'canceled' });
      expect((await h.transitions.voidInvoice(h.context, request)).invoice.status).toBe('void');
      expect((await h.transitions.voidInvoice(h.context, request)).outcome).toBe('ignored');
      await expect(h.transitions.manualPayment(h.context, h.manual)).rejects.toMatchObject({ code: 'conflict' });
      expect((await h.transitions.cardSucceeded(h.context, h.success)).outcome).toBe('duplicate_payment');
      expect((await h.transitions.cardSucceeded(h.context, h.success)).outcome).toBe('ignored');
      const after = await h.read();
      expect(after.invoice).toBe('void');
      expect(count(after.effects, 'refund_duplicate')).toBe(1);
      expect(count(after.effects, 'staff_notice')).toBe(1);
      expect(count(after.effects, 'activate_memberships')).toBe(0);
    });
    it.each([
      { checkoutSessionId: 'cs_reserved' },
      { checkoutExpiresAt: '2100-01-01T00:00:00Z' },
      { checkoutSessionId: 'cs_old', checkoutExpiresAt: '2000-01-01T00:00:00Z' },
    ])('refuses a reserved Checkout: %j', async checkout => {
      const h = await create({ checkout });
      await h.transitions.cardFailed(h.context, { invoiceId: h.success.invoiceId, attemptId: h.success.attemptId,
        paymentIntentId: h.success.paymentIntentId, outcome: 'failed' });
      const before = await h.read();
      await expect(h.transitions.voidInvoice(h.context, { invoiceId: h.success.invoiceId, reason: 'Wrong invoice' }))
        .rejects.toMatchObject({ code: 'conflict', details: { reason: ['checkout_reserved'] } });
      expect(await h.read()).toEqual(before);
    });
    it.each(['failed', 'requires_action', 'canceled'] as const)('ignores %s on a void invoice before changing the attempt', async outcome => {
      const h = await create(), { invoiceId, attemptId, paymentIntentId } = h.success;
      await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'failed' });
      await h.transitions.voidInvoice(h.context, { invoiceId, reason: 'Wrong invoice' });
      const before = await h.read();
      expect((await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome })).outcome).toBe('ignored');
      expect(await h.read()).toEqual(before);
    });
    it('closes a cancelled, never-confirmed attempt as confirm_abandoned without touching the invoice or dunning', async () => {
      const h = await create(), before = await h.read();
      const { invoiceId, attemptId, paymentIntentId } = h.success;
      const result = await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'canceled' });
      expect(result).toMatchObject({ outcome: 'applied', invoice: { status: before.invoice } });
      expect(await h.read()).toEqual({ ...before, attempt: { status: 'failed', declineCode: 'confirm_abandoned' } });
      expect((await h.transitions.cardSucceeded(h.context, h.success)).outcome).toBe('ignored');
      expect((await h.read()).invoice).toBe(before.invoice);
    });
    it('keeps the cancellation of an action-needed attempt a decline with dunning', async () => {
      const h = await create();
      const { invoiceId, attemptId, paymentIntentId } = h.success;
      await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'requires_action' });
      const result = await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'canceled' });
      expect(result).toMatchObject({ outcome: 'applied', invoice: { status: 'past_due' } });
      const after = await h.read();
      expect(after.attempt).toEqual({ status: 'failed', declineCode: 'intent_canceled' });
      expect(count(after.effects, 'dunning')).toBe(2);
      expect((await h.transitions.cardSucceeded(h.context, h.success)).outcome).toBe('ignored');
    });
    it.each([false, true])('reverses a processor refund that fails after success, with pack sale: %s', async packSale => {
      const h = await create({ packSale });
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const part = Math.floor(amountCents * 0.4);
      const first: RefundTransition = { invoiceId, paymentId, refundId: randomUUID(), processorId: 're_contract_1',
        amountCents: part, currency, status: 'succeeded' };
      const second: RefundTransition = { ...first, refundId: randomUUID(), processorId: 're_contract_2', amountCents: amountCents - part };
      const status = async (request: RefundTransition) => (await h.transitions.refund(h.context, request)).invoice.status;
      expect(await status(first)).toBe('partially_refunded');
      expect(count((await h.read()).effects, 'reverse_credits')).toBe(0);
      expect(await status(second)).toBe('refunded');
      expect(count((await h.read()).effects, 'reverse_credits')).toBe(packSale ? 1 : 0);
      await status(second);
      expect(count((await h.read()).effects, 'reverse_credits')).toBe(packSale ? 1 : 0);
      expect(count((await h.read()).effects, 'staff_notice')).toBe(0);
      expect(await status({ ...second, status: 'failed' })).toBe('partially_refunded');
      expect(count((await h.read()).effects, 'staff_notice')).toBe(1);
      // A failed refund never moves again.
      expect((await h.transitions.refund(h.context, second)).outcome).toBe('ignored');
      expect(await status({ ...first, status: 'failed' })).toBe('paid');
      const after = await h.read();
      expect(after.invoice).toBe('paid');
      expect(count(after.effects, 'staff_notice')).toBe(2);
    });
    it('notifies staff once for a processor refund first recorded failed, or failed after pending', async () => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const notices = async () => count((await h.read()).effects, 'staff_notice');
      const failed: RefundTransition = { invoiceId, paymentId, refundId: randomUUID(), processorId: 're_contract_3',
        amountCents, currency, status: 'failed' };
      expect((await h.transitions.refund(h.context, failed)).invoice.status).toBe('paid');
      expect(await notices()).toBe(1);
      expect((await h.transitions.refund(h.context, failed)).outcome).toBe('ignored');
      const pending: RefundTransition = { ...failed, refundId: randomUUID(), processorId: 're_contract_4', status: 'pending' };
      await h.transitions.refund(h.context, pending);
      expect(await notices()).toBe(1);
      expect((await h.transitions.refund(h.context, { ...pending, status: 'failed' })).invoice.status).toBe('paid');
      expect((await h.transitions.refund(h.context, { ...pending, status: 'failed' })).outcome).toBe('ignored');
      expect(await notices()).toBe(2);
      expect((await h.read()).invoice).toBe('paid');
    });
    it('records an external canceled refund as final and released, without notifying staff', async () => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const notices = async () => count((await h.read()).effects, 'staff_notice');
      // Cancelled before the app saw it, and cancelled while pending: each releases the whole amount.
      const first: RefundTransition = { invoiceId, paymentId, refundId: randomUUID(), processorId: 're_contract_5',
        amountCents, currency, status: 'canceled' };
      expect(await h.transitions.refund(h.context, first)).toMatchObject({ outcome: 'applied', invoice: { status: 'paid' } });
      const pending: RefundTransition = { ...first, refundId: randomUUID(), processorId: 're_contract_6', status: 'pending' };
      await h.transitions.refund(h.context, pending);
      expect(await h.transitions.refund(h.context, { ...pending, status: 'canceled' }))
        .toMatchObject({ outcome: 'applied', invoice: { status: 'paid' } });
      // Canceled never moves again.
      for (const status of ['canceled', 'failed', 'succeeded', 'pending'] as const)
        expect((await h.transitions.refund(h.context, { ...pending, status })).outcome).toBe('ignored');
      expect(await notices()).toBe(0);
      // Only the processor cancels a refund, so a cash or check refund can't be recorded canceled.
      await expect(h.transitions.refund(h.context, { invoiceId, paymentId, refundId: randomUUID(), amountCents, currency, status: 'canceled' }))
        .rejects.toMatchObject({ code: 'conflict' });
      // A processor never cancels a refund that succeeded, so such a report leaves the invoice refunded.
      const refunded: RefundTransition = { ...first, refundId: randomUUID(), processorId: 're_contract_7', status: 'succeeded' };
      expect((await h.transitions.refund(h.context, refunded)).invoice.status).toBe('refunded');
      expect((await h.transitions.refund(h.context, { ...refunded, status: 'canceled' })).outcome).toBe('ignored');
      const after = await h.read();
      expect(after.invoice).toBe('refunded');
      expect(count(after.effects, 'staff_notice')).toBe(0);
    });
    it.each(['pending', 'succeeded', 'failed', 'canceled'] as const)('adds the processor ID to a reserved refund reported %s', async status => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const reserved: RefundTransition = { invoiceId, paymentId, amountCents, currency, refundId: randomUUID(), status: 'pending' };
      expect((await h.transitions.refund(h.context, reserved)).outcome).toBe('applied');
      const report = { ...reserved, processorId: 're_contract_reserved', status };
      expect(await h.transitions.refund(h.context, report)).toMatchObject({ outcome: 'applied',
        invoice: { status: status === 'succeeded' ? 'refunded' : 'paid' } });
      expect((await h.transitions.refund(h.context, report)).outcome).toBe('ignored');
      await expect(h.transitions.refund(h.context, { ...report, processorId: 're_different' })).rejects.toMatchObject({ code: 'conflict' });
      await expect(h.transitions.refund(h.context, { ...report, amountCents: amountCents - 1 })).rejects.toMatchObject({ code: 'conflict' });
      expect(count((await h.read()).effects, 'staff_notice')).toBe(status === 'failed' || status === 'canceled' ? 1 : 0);
    });
    it('remembers an app reservation after linking a pending processor refund, and notifies once on cancellation', async () => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const reservation: RefundTransition = { invoiceId, paymentId, amountCents, currency, refundId: randomUUID(), status: 'pending' };
      await h.transitions.refund(h.context, reservation);
      const linked = { ...reservation, processorId: 're_contract_app_pending' };
      await h.transitions.refund(h.context, linked);
      const canceled = { ...linked, status: 'canceled' as const };
      await h.transitions.refund(h.context, canceled);
      await h.transitions.refund(h.context, canceled);
      expect(count((await h.read()).effects, 'staff_notice')).toBe(1);
      expect((await h.read()).invoice).toBe('paid');
    });
    it('never reverses a refund without a processor ID', async () => {
      const h = await create();
      await h.transitions.manualPayment(h.context, h.manual);
      const cash: RefundTransition = { invoiceId: h.manual.invoiceId, paymentId: h.manual.paymentId, refundId: randomUUID(),
        amountCents: Math.floor(h.manual.amountCents / 2), currency: h.manual.currency, status: 'succeeded' };
      expect((await h.transitions.refund(h.context, cash)).invoice.status).toBe('partially_refunded');
      expect((await h.transitions.refund(h.context, { ...cash, status: 'failed' })).outcome).toBe('ignored');
      const after = await h.read();
      expect(after.invoice).toBe('partially_refunded');
      expect(count(after.effects, 'staff_notice')).toBe(0);
    });
  });
}
