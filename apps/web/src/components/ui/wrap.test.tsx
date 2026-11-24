// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button } from './button.js';
import { breaksAnywhere } from './wrap.test-helper.js';
import { AgendaView } from '../../features/schedule/views.js';
import { HouseholdPicker } from '../../features/portal/shell/shell.js';
import { PersonPicker } from '../../features/staff/person-picker.js';
import { BookDialog, LostDialog } from '../../features/leads/dialogs.js';
import { KioskApp } from '../../features/kiosk/kiosk.js';
import { kioskApi, readToken } from '../../features/kiosk/api.js';

vi.mock('../../app/context.js', () => ({
  useBootstrap: () => ({ data: { gym: { timezone: 'UTC' } } }),
}));
vi.mock('../../features/kiosk/api.js', async (original) => ({
  ...await original<typeof import('../../features/kiosk/api.js')>(),
  kioskApi: { lookup: vi.fn(), checkin: vi.fn() },
  readToken: vi.fn(() => 'device-token'),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Keep this case first in the file: the helper compiles each document's classes once per module, and this case needs the
// wrap rules to be the first ones Tailwind emits (right after its license comment). The cases below may add more classes.
describe('breaksAnywhere', () => {
  it('reads the first generated rule like any other', () => {
    render(<p className="wrap-anywhere wrap-normal">{'one'}</p>);
    expect(breaksAnywhere(screen.getByText('one'))).toBe(false);
  });
});

describe('name wrapping', () => {
  it('Button wrap sets data-name-wrap and wrap classes; plain Button sets neither', () => {
    render(<>
      <Button wrap>Wrapped</Button>
      <Button>Plain</Button>
    </>);
    const wrapped = screen.getByRole('button', { name: 'Wrapped' });
    expect(wrapped.getAttribute('data-name-wrap')).toBe('');
    expect(wrapped.classList.contains('min-w-0')).toBe(true);
    expect(wrapped.classList.contains('max-w-full')).toBe(true);
    expect(wrapped.classList.contains('wrap-anywhere')).toBe(true);

    const plain = screen.getByRole('button', { name: 'Plain' });
    expect(plain.getAttribute('data-name-wrap')).toBeNull();
    expect(plain.classList.contains('min-w-0')).toBe(false);
    expect(plain.classList.contains('max-w-full')).toBe(false);
    expect(plain.classList.contains('wrap-anywhere')).toBe(false);
  });

  it('SessionButton and kiosk member checkbox use the shared marker and wrap-anywhere class', async () => {
    const longClass = 'Session'.padEnd(56, 'x');
    render(<AgendaView
      week="2026-11-23"
      today="2026-11-23"
      sessions={[{
        id: '01900000-0000-7000-8000-000000000001',
        templateId: null,
        programIds: [],
        tagIds: [],
        coachId: null,
        name: longClass,
        kind: 'class',
        status: 'scheduled',
        startsAt: '2026-11-23T18:00:00Z',
        endsAt: '2026-11-23T19:00:00Z',
        cancelBefore: '2026-11-23T17:00:00Z',
        capacity: 20,
        notes: null,
        createdAt: '2026-11-23T00:00:00Z',
        revision: 1,
      }]}
      options={{ timezone: 'UTC', coaches: [], programs: [] }}
      onOpen={() => {}}
    />);
    const sessionBtn = screen.getByRole('button', { name: new RegExp(longClass) });
    expect(sessionBtn.getAttribute('data-name-wrap')).toBe('');
    expect(sessionBtn.classList.contains('wrap-anywhere')).toBe(true);

    vi.mocked(readToken).mockReturnValue('device-token');
    vi.mocked(kioskApi.lookup).mockResolvedValue({
      status: 'select_member',
      members: [{ id: '01900000-0000-7000-8000-000000000002', firstName: 'Kioskmember'.padEnd(56, 'x'), lastInitial: 'A', photoUrl: null }],
    });
    render(<KioskApp />);
    const pinBtn = screen.queryByRole('button', { name: 'Name and PIN' });
    if (pinBtn) fireEvent.click(pinBtn);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Rivera' } });
    fireEvent.change(screen.getByLabelText('Household PIN'), { target: { value: '0042' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Find me' })); });

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox.getAttribute('data-name-wrap')).toBe('');
    expect(checkbox.classList.contains('wrap-anywhere')).toBe(true);
  });

  it('household picker, staff person picker, and leads dialog titles inherit wrap-anywhere without repeating it', async () => {
    const longHousehold = 'Household'.padEnd(56, 'x');
    render(<HouseholdPicker
      households={[{ householdId: 'h1', name: longHousehold, role: 'payer' }]}
      onChoose={() => {}}
    />);
    const householdText = screen.getByText(longHousehold);
    expect(householdText.classList.contains('wrap-anywhere')).toBe(false);
    expect(householdText.parentElement?.classList.contains('wrap-anywhere')).toBe(false);
    expect(breaksAnywhere(householdText)).toBe(true);

    vi.useFakeTimers();
    const longPerson = 'Person'.padEnd(56, 'x');
    render(<PersonPicker
      name="personId"
      kind="member"
      services={{
        people: vi.fn().mockResolvedValue({ data: [{ id: 'p1', displayName: longPerson, email: null }], total: 1 }),
        person: vi.fn().mockResolvedValue(null),
      } as unknown as Parameters<typeof PersonPicker>[0]['services']}
    />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const personText = screen.getByText(longPerson);
    expect(personText.classList.contains('wrap-anywhere')).toBe(false);
    expect(breaksAnywhere(personText)).toBe(true);

    const lead = {
      memberId: 'm1',
      householdId: 'h1',
      firstName: 'Lead'.padEnd(56, 'x'),
      lastName: 'Tester',
      email: null,
      phone: null,
      status: 'prospect' as const,
      source: null,
      stage: 'new' as const,
      nextFollowUpOn: null,
      lastContactedAt: null,
      createdAt: '2026-11-23T00:00:00Z',
      revision: 1,
    };
    const leadClient = {
      sessions: vi.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof BookDialog>[0]['client'];

    render(<BookDialog lead={lead} client={leadClient} timezone="UTC" onClose={() => {}} onDone={() => {}} />);
    const bookHeading = screen.getByRole('heading', { name: new RegExp(lead.firstName) });
    expect(bookHeading.querySelector('.wrap-anywhere')).toBeNull();
    expect(breaksAnywhere(bookHeading)).toBe(true);

    cleanup();
    render(<LostDialog lead={lead} client={leadClient} onClose={() => {}} onDone={() => {}} />);
    const lostHeading = screen.getByRole('heading', { name: new RegExp(lead.firstName) });
    expect(lostHeading.querySelector('.wrap-anywhere')).toBeNull();
    expect(breaksAnywhere(lostHeading)).toBe(true);
  });
});
