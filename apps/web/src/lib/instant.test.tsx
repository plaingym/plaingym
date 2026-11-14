// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { bootstrapKey, ShellServicesContext } from '../app/context.js';
import { createShellServices, type ShellBootstrap } from '../app/services.js';
import { calendarDateLabel, dateFormatter, dateLabel, instantLabel, monthLabel, timeLabel, useGymTime, wallTimeLabel } from './instant.js';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
describe('gym date labels', () => {
  it('uses the gym day when the browser is already on the next day', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    const value = '2026-11-02T00:30:00Z';
    expect(new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value))).toBe('Nov 2, 2026');
    expect(dateLabel(value, 'America/Los_Angeles')).toBe('Nov 1, 2026');
    expect(instantLabel(value, 'America/Los_Angeles')).toBe('Nov 1, 2026, 4:30 PM');
  });
  it('handles both sides of the daylight saving fold in the gym zone', () => {
    expect(timeLabel('2026-11-01T08:30:00Z', 'America/Los_Angeles')).toBe('1:30 AM');
    expect(timeLabel('2026-11-01T09:30:00Z', 'America/Los_Angeles')).toBe('1:30 AM');
  });
  it('keeps calendar dates and month ranges fixed across browser zones', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(calendarDateLabel('2026-11-01')).toBe('Nov 1, 2026');
    expect(monthLabel('2026-11')).toBe('November 2026');
    expect(wallTimeLabel('18:00')).toBe('6:00 PM');
    expect(wallTimeLabel('00:30')).toBe('12:30 AM');
  });
  it('reuses a formatter only for the same style, timezone and locale', () => {
    const formatter = dateFormatter('instant', 'Pacific/Honolulu', 'en');
    expect(dateFormatter('instant', 'Pacific/Honolulu', 'en')).toBe(formatter);
    expect(dateFormatter('date', 'Pacific/Honolulu', 'en')).not.toBe(formatter);
    expect(dateFormatter('instant', 'Asia/Tokyo', 'en')).not.toBe(formatter);
    expect(dateFormatter('instant', 'Pacific/Honolulu', 'fr')).not.toBe(formatter);
  });
  it('takes its clock style from the locale', () => {
    expect(timeLabel('2026-11-01T14:30:00Z', 'America/Los_Angeles', 'en')).toBe('6:30 AM');
    expect(timeLabel('2026-11-01T14:30:00Z', 'America/Los_Angeles', 'en-GB')).toBe('6:30');
    expect(wallTimeLabel('06:30', 'en-GB')).toBe('6:30');
  });
  it('preserves non-date values', () => {
    expect(instantLabel('not a date', 'UTC')).toBe('not a date');
    expect(dateLabel('not a date', 'UTC')).toBe('not a date');
    expect(calendarDateLabel('unknown')).toBe('unknown');
    expect(monthLabel('unknown')).toBe('unknown');
    expect(wallTimeLabel('unknown')).toBe('unknown');
  });
  it('uses an explicit zone independently of the browser', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(dateLabel('2026-11-02T00:30:00Z', 'UTC')).toBe('Nov 2, 2026');
  });
  it('observes bootstrap timezone changes', async () => {
    const bootstrap: ShellBootstrap = { gym: { id: 'gym', name: 'Gym', timezone: 'America/Los_Angeles', currency: 'USD', enabledModules: [] },
      session: null, login: { password: true, magicLink: false } };
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(bootstrapKey, bootstrap);
    function Label() { const time = useGymTime(); return <p>{time.instantLabel('2026-11-02T00:30:00Z')}</p>; }
    render(<QueryClientProvider client={client}><ShellServicesContext.Provider value={createShellServices(async () => bootstrap)}><Label /></ShellServicesContext.Provider></QueryClientProvider>);
    expect(screen.getByText('Nov 1, 2026, 4:30 PM')).toBeDefined();
    await act(async () => { client.setQueryData(bootstrapKey, { ...bootstrap, gym: { ...bootstrap.gym, timezone: 'Asia/Tokyo' } }); });
    expect(await screen.findByText('Nov 2, 2026, 9:30 AM')).toBeDefined();
  });
});
