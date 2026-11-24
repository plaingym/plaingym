// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Household, Member } from '@plaingym/shared/contracts';
import { samePhoneAs, SmsConsentControls, StaffSmsConsent } from './sms-consent.js';

const request = vi.hoisted(() => vi.fn());
vi.mock('./api.js', () => ({ memberRequest: request }));
vi.mock('../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { name: 'River Gym', timezone: 'America/Los_Angeles' } } }) }));

afterEach(() => { cleanup(); request.mockReset(); });
const sms = { phoneValid: true, phoneE164: '+12025550123', notices: null, announcements: null };
const consent = { at: '2026-11-16T12:00:00Z', source: 'join' as const };
it('explains an invalid phone and prevents opt-in; staff never get an announcements grant button', () => {
  render(<SmsConsentControls sms={{ ...sms, phoneValid: false, phoneE164: null }} gymName="River Gym" staff onChange={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Record verbal notices consent' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Text messages need a valid phone number/)).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Agree to announcements' })).toBeNull();
  expect(screen.getByText(/news from River Gym/)).toBeDefined();
});
it('withdraws either consent with one tap, permits staff withdrawal, and shows save failures', async () => {
  const onChange = vi.fn().mockRejectedValue(new Error('conflict'));
  render(<SmsConsentControls sms={{ ...sms, notices: consent, announcements: consent }} gymName="River Gym" staff onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw announcements consent' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('announcements', false));
  expect(await screen.findByRole('alert')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw notices consent' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('notices', false));
});
it('formats the recorded consent time in the gym timezone and fixed English locale', () => {
  render(<SmsConsentControls sms={{ ...sms, notices: { at: '2026-11-15T18:30:00Z', source: 'join' } }} gymName="River Gym" timezone="America/Los_Angeles" onChange={vi.fn()} />);
  expect(screen.getByText('Consented Nov 15, 2026, 10:30 AM via the join form.')).toBeDefined();
});

describe('a number that replied STOP', () => {
  // 03:00 UTC on the 21st is still the 20th in the gym's timezone.
  const optedOut = { ...sms, optedOutAt: '2026-11-21T03:00:00Z' };
  const stopLine = 'This number replied STOP on Nov 20, 2026. Texts can\'t reach it until the person replies START to River Gym\'s number.';
  const staffLine = 'Record verbal consent again only after the person confirms they replied START.';
  it('names the date in the gym timezone', () => {
    render(<SmsConsentControls sms={optedOut} gymName="River Gym" timezone="America/Los_Angeles" onChange={vi.fn()} />);
    expect(screen.getByText(stopLine)).toBeDefined();
    expect(screen.queryByText(staffLine)).toBeNull();
  });
  it('tells staff to confirm START first and keeps verbal consent available', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<SmsConsentControls sms={optedOut} gymName="River Gym" timezone="America/Los_Angeles" staff onChange={onChange} />);
    expect(screen.getByText(stopLine)).toBeDefined();
    expect(screen.getByText(staffLine)).toBeDefined();
    const record = screen.getByRole('button', { name: 'Record verbal notices consent' }) as HTMLButtonElement;
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('notices', true));
  });
  it.each([undefined, null])('shows neither line when the opted-out date is %s', optedOutAt => {
    render(<SmsConsentControls sms={{ ...sms, ...(optedOutAt === undefined ? {} : { optedOutAt }) }} gymName="River Gym" timezone="UTC" staff onChange={vi.fn()} />);
    expect(screen.queryByText(/replied STOP on/)).toBeNull();
    expect(screen.queryByText(staffLine)).toBeNull();
  });
});

describe('a phone shared with the household', () => {
  const home = { sms: { phoneValid: true, phoneE164: '+12025550123', notices: null } };
  const person = { sms };
  it.each([
    [true, 'This is also the household billing phone. Its billing notices consent is on.'],
    [false, 'This is also the household billing phone. Its billing notices consent is off.'],
  ])('shows the household consent on the member panel (on: %s)', (on, line) => {
    const samePhone = samePhoneAs(person, { sms: { ...home.sms, notices: on ? consent : null } }, { other: 'household' });
    render(<SmsConsentControls sms={sms} gymName="River Gym" samePhone={samePhone} onChange={vi.fn()} />);
    expect(screen.getByText(line)).toBeDefined();
  });
  it.each([
    [true, 'This is also Ana Silva\'s own phone. Their notices consent is on.'],
    [false, 'This is also Ana Silva\'s own phone. Their notices consent is off.'],
  ])('shows the member consent on the household panel (on: %s)', (on, line) => {
    const samePhone = samePhoneAs(home, { sms: { ...sms, notices: on ? consent : null } }, { other: 'member', name: 'Ana Silva' });
    render(<SmsConsentControls sms={home.sms} gymName="River Gym" samePhone={samePhone} onChange={vi.fn()} />);
    expect(screen.getByText(line)).toBeDefined();
  });
  it('shows no line for a different number, a missing number on either side, or no other record', () => {
    const none = { sms: { ...sms, phoneValid: false, phoneE164: null } };
    expect(samePhoneAs(person, { sms: { ...home.sms, phoneE164: '+12025550199' } }, { other: 'household' })).toBeUndefined();
    expect(samePhoneAs(none, { sms: { ...home.sms, phoneE164: null } }, { other: 'household' })).toBeUndefined();
    expect(samePhoneAs(person, { sms: { ...home.sms, phoneE164: null } }, { other: 'household' })).toBeUndefined();
    expect(samePhoneAs(none, home, { other: 'household' })).toBeUndefined();
    expect(samePhoneAs(home, undefined, { other: 'member', name: 'Ana Silva' })).toBeUndefined();
    render(<SmsConsentControls sms={sms} gymName="River Gym" samePhone={undefined} onChange={vi.fn()} />);
    expect(screen.queryByText(/This is also/)).toBeNull();
  });
  it('records consent on the member panel with only the member request', async () => {
    const member = { id: '019a08bf-1234-7000-8000-000000000001', revision: 3, firstName: 'Ana', lastName: 'Silva', sms } as unknown as Member;
    const household = { id: '019a08bf-1234-7000-8000-000000000002', revision: 5, sms: { ...home.sms, notices: consent } } as unknown as Household;
    request.mockResolvedValue({ data: member });
    render(<QueryClientProvider client={new QueryClient()}>
      <StaffSmsConsent record={member} samePhone={samePhoneAs(member, household, { other: 'household' })} />
      <StaffSmsConsent record={household} household samePhone={samePhoneAs(household, member, { other: 'member', name: 'Ana Silva' })} />
    </QueryClientProvider>);
    expect(screen.getByText('This is also the household billing phone. Its billing notices consent is on.')).toBeDefined();
    expect(screen.getByText('This is also Ana Silva\'s own phone. Their notices consent is off.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Record verbal notices consent' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(expect.anything(), `/api/members/${member.id}/sms-consent`, 'PUT', { kind: 'notices', consent: true, revision: 3 });
  });
});
