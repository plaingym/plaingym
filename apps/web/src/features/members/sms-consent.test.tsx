// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SmsConsentControls } from './sms-consent.js';

afterEach(cleanup);
const sms = { phoneValid: true, phoneE164: '+12025550123', notices: null, announcements: null };
it('explains an invalid phone and prevents opt-in; staff never get an announcements grant button', () => {
  render(<SmsConsentControls sms={{ ...sms, phoneValid: false, phoneE164: null }} gymName="River Gym" staff onChange={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Record verbal notices consent' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Text messages need a valid phone number/)).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Agree to announcements' })).toBeNull();
  expect(screen.getByText(/news from River Gym/)).toBeDefined();
});
it('withdraws either consent with one tap, permits staff withdrawal, and shows save failures', async () => {
  const onChange = vi.fn().mockRejectedValue(new Error('conflict'));
  const consent = { at: '2026-11-16T12:00:00Z', source: 'join' as const };
  render(<SmsConsentControls sms={{ ...sms, notices: consent, announcements: consent }} gymName="River Gym" staff onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw announcements consent' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('announcements', false));
  expect(await screen.findByRole('alert')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw notices consent' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('notices', false));
});
