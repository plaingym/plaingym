// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Plan, PlanPriceChangeMembership, PlanPriceChangePreview, PlanPriceChangeResult } from '@plaingym/shared/contracts';
import { ApiError } from '../../../lib/api.js';
import type { BillingClient } from './api.js';
import { PriceChange } from './price-change.js';

const id = (n: number) => '019a0000-0000-7000-8000-' + String(n).padStart(12, '0');
const plan: Plan = { id: id(1), name: 'All classes', amountCents: 10000, currency: 'CAD', interval: 'monthly', signupFeeCents: 0,
  trialDays: 0, commitmentMonths: null, active: true, revision: 4, taxRateIds: [], createdAt: '2026-11-01T00:00:00Z' };
const member = (n: number, extra: Partial<PlanPriceChangeMembership> = {}): PlanPriceChangeMembership => ({ id: id(n), revision: n,
  householdId: id(n + 100), memberName: ['Ada', 'Bea', 'Cal', 'Dee', 'Eve', 'Fox'][n - 2] ?? 'Member ' + n,
  status: 'active', amountCents: 10000, currency: 'CAD', interval: 'monthly', commitmentEndsOn: null, inCommitment: false,
  customPrice: false, scheduled: null, tickedByDefault: true, includedByAll: true, skipReason: null, householdReach: 'ok', ...extra });
const rows = [member(2), member(3, { status: 'frozen', tickedByDefault: false }),
  member(4, { inCommitment: true, commitmentEndsOn: '2027-06-01', tickedByDefault: false, includedByAll: false }),
  member(5, { customPrice: true, amountCents: 9000, tickedByDefault: false, includedByAll: false }),
  member(6, { skipReason: 'switch_scheduled', tickedByDefault: false, includedByAll: false }),
  member(7, { householdReach: 'suppressed' })];
const initial: PlanPriceChangePreview = { plan, amountCents: 12000, effectiveOn: '2026-12-13', today: '2026-11-13', change: 'increase',
  memberships: rows, total: rows.length, households: 5, householdsWithoutAddress: 0, householdsPayerErased: 0, householdsSuppressed: 1, switchesToPlan: 1, canEmail: true };
const result: PlanPriceChangeResult = { planId: plan.id, amountCents: 12000, effectiveOn: initial.effectiveOn,
  scheduled: [id(2)], skipped: [{ id: id(7), reason: 'changed' }], householdsNotified: 1, householdsWithoutAddress: 0, householdsPayerErased: 0, householdsSuppressed: 0 };
const input = { revision: 4, amountCents: 12000, name: 'Renamed', taxRateIds: [] };
function start(changes: Partial<PlanPriceChangePreview> = {}) {
  const call = vi.fn(async (name: string) => ({ data: name === 'updatePlan' ? { ...plan, revision: 5 }
    : name === 'previewPlanPriceChange' ? { ...initial, ...changes } : result }));
  const client = { call } as unknown as BillingClient;
  const done = vi.fn(async () => {}), reload = vi.fn(async () => {}), cancel = vi.fn();
  render(<PriceChange plan={plan} input={input} initial={{ ...initial, ...changes }} client={client} done={done} reload={reload} cancel={cancel}/>);
  return { call, done, reload, cancel };
}
const choose = (name = 'Choose members') => fireEvent.click(screen.getByRole('radio', { name }));
const tick = (name: string) => screen.getAllByRole('checkbox', { name: 'Move ' + name })[0] as HTMLInputElement;
const review = () => fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply price change' }));
afterEach(cleanup);

describe('plan price change step', () => {
  it('saves new members only through the plan update, without calling apply', async () => {
    const f = start(); review(); apply();
    await waitFor(() => expect(f.done).toHaveBeenCalledOnce());
    expect(f.call.mock.calls).toEqual([['updatePlan', input, { planId: plan.id }]]);
  });
  it('defaults to the preview ticks and an email notice, leaving exceptional rows tickable and skipped rows disabled', () => {
    start(); choose();
    expect((screen.getByLabelText('Email households about this change') as HTMLInputElement).checked).toBe(true);
    expect(['Ada', 'Bea', 'Cal', 'Dee', 'Eve', 'Fox'].map(name => tick(name).checked)).toEqual([true, false, false, false, false, true]);
    expect(tick('Cal').disabled).toBe(false); expect(tick('Dee').disabled).toBe(false); expect(tick('Eve').disabled).toBe(true);
    expect(screen.getAllByText('A switch to another plan is already scheduled.')).toHaveLength(2);
  });
  it('filters by name, status, commitment and custom price without changing the selection', () => {
    start(); choose();
    fireEvent.change(screen.getByLabelText('Search by member name'), { target: { value: 'cal' } });
    expect(screen.queryByRole('checkbox', { name: 'Move Ada' })).toBeNull(); expect(tick('Cal')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search by member name'), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'frozen' } }); expect(tick('Bea')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Move Ada' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('In a commitment')); expect(tick('Cal')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('In a commitment')); fireEvent.click(screen.getByLabelText('Custom price', { selector: 'input' })); expect(tick('Dee')).toBeTruthy();
    expect(screen.getByText('Selected: 2. Visible with these filters: 1. Filters do not change your selection.')).toBeTruthy();
  });
  it('sends exactly the chosen subset, including explicit commitment and custom-price ticks, using the updated plan revision', async () => {
    const f = start(); choose(); fireEvent.click(tick('Ada')); fireEvent.click(tick('Fox')); fireEvent.click(tick('Cal')); fireEvent.click(tick('Dee'));
    review(); apply(); await screen.findByRole('heading', { name: 'Price change result' });
    expect(f.call).toHaveBeenNthCalledWith(1, 'updatePlan', { ...input, amountCents: 10000 }, { planId: plan.id });
    expect(f.call).toHaveBeenNthCalledWith(2, 'applyPlanPriceChange', expect.objectContaining({ planRevision: 5, amountCents: 12000, notify: true,
      effectiveOn: initial.effectiveOn, memberships: [{ id: id(4), revision: 4 }, { id: id(5), revision: 5 }] }), { planId: plan.id });
  });
  it.each([false, true])('All includes frozen memberships and includes exceptions only when requested: %s', async include => {
    const f = start(); choose('All existing members');
    expect(tick('Bea').checked).toBe(true); expect(tick('Cal').checked).toBe(false);
    if (include) fireEvent.click(screen.getByLabelText('Include commitments and custom prices too'));
    review();
    expect(screen.getByText('Frozen memberships moving: 1.')).toBeTruthy();
    expect(screen.getByText(`Memberships keeping their terms: in a commitment ${include ? 0 : 1}; custom price ${include ? 0 : 1}. A membership can be in both groups.`)).toBeTruthy();
    apply(); await screen.findByRole('heading', { name: 'Price change result' });
    expect(f.call).toHaveBeenLastCalledWith('applyPlanPriceChange', expect.objectContaining({ memberships: rows.filter(row => !row.skipReason && (include || row.includedByAll))
      .map(row => ({ id: row.id, revision: row.revision })) }), { planId: plan.id });
  });
  it('keeps the key, revision, date, notice and list across an ambiguous failure and retries without another plan update', async () => {
    const f = start(); f.call.mockResolvedValueOnce({ data: { ...plan, revision: 5 } }).mockRejectedValueOnce(new Error('Connection lost'));
    choose(); review(); apply(); await screen.findByRole('alert');
    const retry = screen.getByRole('button', { name: 'Retry this price change' }); fireEvent.click(retry);
    await screen.findByRole('heading', { name: 'Price change result' });
    expect(f.call.mock.calls[1]).toEqual(f.call.mock.calls[2]); expect(f.call.mock.calls.filter(call => call[0] === 'updatePlan')).toHaveLength(1);
  });
  it('offers the reload as a way out when an attempted apply keeps failing', async () => {
    const f = start(); f.call.mockResolvedValueOnce({ data: { ...plan, revision: 5 } }).mockRejectedValueOnce(new Error('Still failing'));
    choose(); review(); apply(); await screen.findByRole('alert');
    expect(screen.getAllByRole('button', { name: 'Cancel' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole('button', { name: 'Retry this price change' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload plan and start again' })); await waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
  });
  it('disables and unticks the notice when member email is unavailable, and sends notify false', async () => {
    const f = start({ canEmail: false, change: 'decrease', amountCents: 9000 }); choose();
    const notice = screen.getByLabelText('Email households about this change') as HTMLInputElement;
    expect(notice.checked).toBe(false); expect(notice.disabled).toBe(true); expect(screen.getByRole('note')).toBeTruthy();
    review(); apply(); await screen.findByRole('heading', { name: 'Price change result' });
    expect(f.call).toHaveBeenLastCalledWith('applyPlanPriceChange', expect.objectContaining({ notify: false }), { planId: plan.id });
  });
  it('counts selected households once, separating suppressed, missing-address and erased payers', () => {
    start({ memberships: [member(2), member(3, { householdId: id(102) }), member(4, { householdReach: 'no_address' }),
      member(5, { householdReach: 'payer_erased' }), member(6, { householdReach: 'suppressed' })] }); choose(); review();
    expect(screen.getByText('Households to email: 1.')).toBeTruthy();
    expect(screen.getByText('Households without a valid email address: 1. Tell them another way.')).toBeTruthy();
    expect(screen.getByText(/Households not emailed because.*: 1\./)).toBeTruthy(); expect(screen.getByText(/Households whose payer was erased: 1\./)).toBeTruthy();
  });
  it.each([{ date: '2026-11-20', notify: true }, { date: initial.effectiveOn, notify: false }])('requires confirmation for an increase on $date with notify $notify', ({ date, notify }) => {
    start({ effectiveOn: date }); choose(); if (!notify) fireEvent.click(screen.getByLabelText('Email households about this change')); review();
    const button = screen.getByRole('button', { name: 'Apply price change' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(screen.getByLabelText(/I confirm applying this increase/)); expect(button.disabled).toBe(false);
  });
  it('does not warn for a decrease, even today and without email', () => {
    start({ effectiveOn: initial.today, amountCents: 9000, change: 'decrease', canEmail: false }); choose(); review();
    expect(screen.queryByText(/This increase gives fewer/)).toBeNull(); expect((screen.getByRole('button', { name: 'Apply price change' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows the result with member names, skip reasons and truthful notice counts', async () => {
    const f = start(); choose(); review(); apply();
    await screen.findByRole('heading', { name: 'Price change result' });
    expect(screen.getByText('Ada', { selector: 'li' })).toBeTruthy(); expect(screen.getByText(/Fox: The membership changed/)).toBeTruthy();
    expect(screen.getByText(/Reachable households with a notice queued: 1\./)).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(f.done).toHaveBeenCalledOnce());
  });
  it.each([{ reasons: [] }, { reasons: ['request_reused'] }])('blocks a stale or reused request and offers reload: $reasons', async ({ reasons }) => {
    const f = start(); f.call.mockResolvedValueOnce({ data: { ...plan, revision: 5 } }).mockRejectedValueOnce(new ApiError(409, 'conflict', reasons));
    choose(); review(); apply(); await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'Retry this price change' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload plan and start again' })); await waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
  });
  it('requires a fresh preview for a new date before review', async () => {
    const f = start(); choose();
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-12-20' } });
    expect((screen.getByRole('button', { name: 'Review change' }) as HTMLButtonElement).disabled).toBe(true);
    f.call.mockResolvedValueOnce({ data: { ...initial, effectiveOn: '2026-12-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update preview for this date' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Review change' }) as HTMLButtonElement).disabled).toBe(false));
    expect(f.call).toHaveBeenCalledWith('previewPlanPriceChange', undefined, { planId: plan.id }, { amountCents: 12000, effectiveOn: '2026-12-20' });
  });
  it('refuses All when the preview is truncated, while permitting an explicit subset', () => {
    start({ total: 2001 }); choose('All existing members'); expect(screen.getByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review change' }) as HTMLButtonElement).disabled).toBe(true); choose();
    expect((screen.getByRole('button', { name: 'Review change' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
