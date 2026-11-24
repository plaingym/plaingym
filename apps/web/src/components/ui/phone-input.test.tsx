// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhoneInput } from './phone-input.js';

afterEach(cleanup);
/** A parent that keeps the value, with a button that discards it as a form reset does. */
function Harness({ initial = '', onChange, defaultCountry = 'CA', hint }: { initial?: string; onChange: (value: string) => void; defaultCountry?: string; hint?: string }) {
  const [value, setValue] = useState(initial);
  return <div>
    <PhoneInput id="phone" label="Phone" value={value} onChange={(next) => { setValue(next); onChange(next); }} defaultCountry={defaultCountry} {...(hint ? { hint } : {})}/>
    <button type="button" onClick={() => setValue('')}>Discard</button>
  </div>;
}
const country = () => screen.getByRole('combobox', { name: 'Country code' }) as HTMLSelectElement;
const number = () => screen.getByLabelText('Phone') as HTMLInputElement;

describe('PhoneInput', () => {
  it('joins the preselected country code to a typed number, and drops it when no country is chosen', async () => {
    const user = userEvent.setup(), onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    expect(country().value).toBe('CA');
    await user.type(number(), '604 555 0123');
    expect(onChange).toHaveBeenLastCalledWith('+1 604 555 0123');
    await user.selectOptions(country(), 'Choose a country');
    expect(onChange).toHaveBeenLastCalledWith('604 555 0123');
    expect(number().value).toBe('604 555 0123');
  });

  it('sends a number that starts with + as typed, and shows no country while it does', async () => {
    const user = userEvent.setup(), onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    await user.type(number(), '+44 20 7946 0018');
    expect(onChange).toHaveBeenLastCalledWith('+44 20 7946 0018');
    expect(country().value).toBe('');
  });

  it('keeps showing no country for a + number when another country is chosen, and sends the number as typed', async () => {
    const user = userEvent.setup(), onChange = vi.fn();
    render(<Harness initial="+44 20 7946 0018" onChange={onChange}/>);
    expect(country().value).toBe('');
    await user.selectOptions(country(), 'CA');
    expect(country().value).toBe('');
    expect(country().selectedOptions[0]!.textContent).toBe('Choose a country');
    expect(onChange).toHaveBeenLastCalledWith('+44 20 7946 0018');
  });

  it('drops a country chosen with an empty number when the parent resets with a new reset key', async () => {
    const user = userEvent.setup();
    function Reset() {
      const [value, setValue] = useState(''), [resets, setResets] = useState(0);
      return <div>
        <PhoneInput id="phone" label="Phone" value={value} onChange={setValue} defaultCountry="CA" resetKey={resets}/>
        <button type="button" onClick={() => { setValue(''); setResets((count) => count + 1); }}>Reset</button>
      </div>;
    }
    render(<Reset/>);
    await user.selectOptions(country(), 'GB');
    expect(country().value).toBe('GB');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(country().value).toBe('CA');
  });

  it('autofills the number as a full phone number', () => {
    render(<Harness onChange={vi.fn()}/>);
    expect(number().getAttribute('autocomplete')).toBe('tel');
  });

  it('shows an error under the field and marks the number invalid', () => {
    const { rerender } = render(<PhoneInput id="phone" label="Phone" value="" onChange={vi.fn()} hint="Set the country."/>);
    expect(number().getAttribute('aria-invalid')).toBeNull();
    expect(number().getAttribute('aria-describedby')).toBe('phone-hint');
    rerender(<PhoneInput id="phone" label="Phone" value="" onChange={vi.fn()} hint="Set the country." error="Too long."/>);
    expect(screen.getByRole('alert').textContent).toBe('Too long.');
    expect(number().getAttribute('aria-invalid')).toBe('true');
    expect(number().getAttribute('aria-describedby')).toBe('phone-hint phone-error');
  });

  it('shows a stored number split into its choice and number without calling onChange', () => {
    const onChange = vi.fn();
    render(<Harness initial="+1 604 555 0123" onChange={onChange}/>);
    expect(country().value).toBe('CA');
    expect(number().value).toBe('604 555 0123');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('empties when the parent discards the value', async () => {
    const user = userEvent.setup(), onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    await user.type(number(), '604');
    expect(number().value).toBe('604');
    const calls = onChange.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(number().value).toBe('');
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it('shows a hint only when given, and limits the number to 95 characters by default', () => {
    const { rerender } = render(<Harness onChange={vi.fn()}/>);
    expect(screen.queryByText('Set the country.')).toBeNull();
    expect(document.querySelector('p')).toBeNull();
    expect(number().maxLength).toBe(95);
    rerender(<Harness onChange={vi.fn()} hint="Set the country."/>);
    expect(screen.getByText('Set the country.')).toBeDefined();
  });
});
