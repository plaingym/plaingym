// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Plan, TaxRate } from '@plaingym/shared/contracts';
import { CatalogEditor } from './editor.js';

afterEach(cleanup);
const plan: Plan = { id: '01900000-0000-7000-8000-000000000001', createdAt: '2026-11-01T00:00:00Z',
  name: 'Monthly', revision: 1, currency: 'USD', amountCents: 4000, active: true, taxRateIds: [], interval: 'monthly',
  signupFeeCents: 0, trialDays: 0, commitmentMonths: null };
const tax: TaxRate = { id: plan.id, createdAt: plan.createdAt, revision: 1, name: 'Sales tax', active: true, rateMillionths: 50000, inclusive: false };

describe('catalog draft reloads', () => {
  it('shows the latest same-field value next to the retained draft, keeps it across reloads and clears it on agreement', () => {
    const props = { kind: 'plans' as const, currency: 'USD', taxes: [], busy: false, save: vi.fn(), cancel: vi.fn() };
    const { rerender } = render(<CatalogEditor {...props} record={plan}/>);
    fireEvent.change(screen.getByLabelText('Amount (USD)'), { target: { value: '45.00' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My draft' } });
    const fresh = { ...plan, revision: 2, amountCents: 5000, name: 'Latest name', signupFeeCents: 1000 };
    rerender(<CatalogEditor {...props} record={fresh}/>);
    const amount = screen.getByLabelText('Amount (USD)') as HTMLInputElement;
    expect(amount.value).toBe('45.00');
    expect(within(amount.parentElement!.parentElement!).getByRole('note').textContent).toContain('50.00');
    expect(screen.getByText(/Latest value: Latest name/)).toBeTruthy();
    expect((screen.getByLabelText('Sign-up fee (USD)') as HTMLInputElement).value).toBe('10.00');
    expect(screen.getAllByRole('note')).toHaveLength(2);
    rerender(<CatalogEditor {...props} record={{ ...fresh, revision: 3 }}/>);
    expect(screen.getAllByRole('note')).toHaveLength(2);
    fireEvent.change(amount, { target: { value: '50.00' } });
    expect(screen.getAllByRole('note')).toHaveLength(1);
    rerender(<CatalogEditor {...props} record={{ ...fresh, revision: 4, name: 'My draft' }}/>);
    expect(screen.queryByRole('note')).toBeNull();
  });
  it('marks a tax rate changed by both editors', () => {
    const props = { kind: 'taxes' as const, currency: 'USD', taxes: [], busy: false, save: vi.fn(), cancel: vi.fn() };
    const { rerender } = render(<CatalogEditor {...props} record={tax}/>);
    fireEvent.change(screen.getByLabelText('Tax rate (%)'), { target: { value: '7.5' } });
    rerender(<CatalogEditor {...props} record={{ ...tax, revision: 2, rateMillionths: 82500 }}/>);
    expect((screen.getByLabelText('Tax rate (%)') as HTMLInputElement).value).toBe('7.5');
    expect(screen.getByRole('note').textContent).toContain('8.25');
  });
  it.each(['plans', 'taxes', 'charges'] as const)('saves controlled %s values even when DOM form values differ', async kind => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CatalogEditor kind={kind} currency="USD" taxes={[]} busy={false} save={save} cancel={vi.fn()}/>);
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: ' Draft name ' } });
    fireEvent.click(screen.getByLabelText('Active'));
    if (kind === 'taxes') {
      fireEvent.change(screen.getByLabelText('Tax rate (%)'), { target: { value: '8.125' } });
      fireEvent.click(screen.getByLabelText('Tax included'));
    } else {
      fireEvent.change(screen.getByLabelText('Amount (USD)'), { target: { value: '45.29' } });
      if (kind === 'plans') {
        fireEvent.change(screen.getByLabelText('Billing interval'), { target: { value: 'annual' } });
        fireEvent.change(screen.getByLabelText('Sign-up fee (USD)'), { target: { value: '3.12' } });
        fireEvent.change(screen.getByLabelText('Trial days'), { target: { value: '7' } });
        fireEvent.change(screen.getByLabelText('Commitment (months, optional)'), { target: { value: '6' } });
      }
    }
    // DOM mutations do not change React's controlled draft. A disabled fieldset also vanishes from FormData.
    name.value = 'Different DOM value';
    name.closest('fieldset')!.disabled = true;
    fireEvent.submit(name.closest('form')!);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Draft name', active: false,
      ...(kind === 'taxes' ? { rateMillionths: 81250, inclusive: true } : { amountCents: 4529, currency: 'USD', taxRateIds: [] }),
      ...(kind === 'plans' ? { interval: 'annual', signupFeeCents: 312, trialDays: 7, commitmentMonths: 6 } : {}),
    }));
  });
});
