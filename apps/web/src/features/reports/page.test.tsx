// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import { ShellServicesContext } from '../../app/context.js';
import { createShellServices } from '../../app/services.js';
import { visibleAdminNavigation } from '../../app/admin-shell.js';
import { createRegistries } from '../../lib/registries.js';
import { ReportsPage, ReportsWorkspace, type ReportName } from './page.js';
import { reportClient, type ReportClient } from './api.js';
import * as csv from './csv.js';
import { attendanceFixture, membersFixture, revenueFixture, fixtureId } from './fixtures.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function client(): ReportClient {
  return { attendance: vi.fn(async () => attendanceFixture), members: vi.fn(async () => membersFixture), revenue: vi.fn(async () => revenueFixture) };
}
function provider(content: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{content}</QueryClientProvider>);
}
function mount(service = client(), roles: readonly StaffRole[] = ['owner']) {
  return provider(<ReportsWorkspace gymId={fixtureId} userId={fixtureId} timezone="America/Los_Angeles" roles={roles} client={service} />);
}
const titles = { attendance: 'Attendance', members: 'Members', revenue: 'Revenue' };
async function choose(name: ReportName) {
  await userEvent.click(screen.getByRole('tab', { name: titles[name] }));
  await screen.findAllByRole('table');
}
function renderedCells(table: HTMLElement) {
  return within(table).getAllByRole('row').map(row => [...row.querySelectorAll('th, td')].map(cell => cell.textContent ?? ''));
}
function csvCells(value: string, columns: number) {
  expect(value.startsWith('\uFEFF')).toBe(true);
  const cells = [...value.matchAll(/"((?:[^"]|"")*)"(?=,|\r\n)/g)].map(match => match[1]!.replaceAll('""', '"'));
  const rows: string[][] = [];
  for (let index = 0; index < cells.length; index += columns) rows.push(cells.slice(index, index + columns));
  return rows;
}

describe('report tables and CSV downloads', () => {
  it('resets a program removed from a refetched report and immediately displays all programs', async () => {
    const service = client(), cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={cache}><ReportsWorkspace gymId={fixtureId} userId={fixtureId} timezone="America/Los_Angeles" roles={['owner']} client={service} /></QueryClientProvider>);
    await screen.findByRole('table');
    await userEvent.selectOptions(screen.getByLabelText('Program', { exact: true }), fixtureId);
    vi.mocked(service.attendance).mockResolvedValue({ ...attendanceFixture,
      buckets: attendanceFixture.buckets.map(bucket => ({ ...bucket, programs: bucket.programs.filter(program => program.programId !== fixtureId) })) });
    await cache.invalidateQueries({ queryKey: ['reports', fixtureId, fixtureId, 'attendance'] });
    await waitFor(() => expect(screen.getByLabelText('Program', { exact: true })).toHaveProperty('value', 'all'));
    expect(renderedCells(screen.getByRole('table'))[1]!.slice(-3)).toEqual(['All programs', '9', '4']);
  });
  it.each(['attendance', 'members', 'revenue'] as const)('%s downloads exactly the displayed rows and columns, with formula neutralization only', async name => {
    const downloads: { value: string; filename: string }[] = [];
    vi.spyOn(csv, 'downloadCsv').mockImplementation((table, filename) => { downloads.push({ value: csv.reportCsv(table), filename }); });
    mount(); await choose(name);
    const tables = screen.getAllByRole('table');
    for (const table of tables) {
      const title = table.querySelector('caption')!.textContent!;
      await userEvent.click(screen.getByRole('button', { name: 'Download CSV: ' + title }));
      const download = downloads.at(-1)!;
      const rendered = renderedCells(table);
      expect(csvCells(download.value, rendered[0]!.length)).toEqual(rendered.map(row => row.map(cell => /^[=+\-@\t\r]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell) ? "'" + cell : cell)));
      expect(download.filename).toMatch(new RegExp('^' + name + '-\\d{4}-\\d{2}-\\d{4}-\\d{2}.*\\.csv$'));
    }
    if (name === 'attendance') {
      expect(renderedCells(tables[0]!)[1]!.slice(-3)).toEqual(['All programs', '9', '4']);
      expect(renderedCells(tables[0]!)[2]!.slice(-3)).toEqual(['=Program, "adults"\nMonday', '7', '3']);
      expect(renderedCells(tables[0]!)[4]!.slice(-3)).toEqual(['All programs', '0', '0']);
    } else if (name === 'members') {
      const rows = renderedCells(tables[0]!);
      expect(rows[1]!.slice(-8)).toEqual(['10', '2', '1', '3', '0', '10', '2', '30.00%']);
      expect(rows[2]!.at(-1)).toBe('N/A');
      expect(rows[2]![2]).toBe('In progress');
    } else {
      expect(tables).toHaveLength(3);
      const usd = renderedCells(tables[0]!);
      expect(usd[1]!.slice(-6)).toEqual(['USD', 'Plan', '@Plan, "adults"\nMonthly', '50.00', '0.00', '50.00']);
      expect(usd[2]!.slice(-5)).toEqual(['Tax', 'Local tax', '5.00', '0.00', '5.00']);
      expect(usd[5]!.at(-1)).toBe('-10.00');
      expect(renderedCells(tables[1]!)[1]!.at(-1)).toBe('5000');
      expect(renderedCells(tables[2]!)[1]!.at(-1)).toBe('5.00');
    }
  });

  it('filters attendance, includes missing zero periods, and requests weeks using the same month range', async () => {
    const service = client(); mount(service);
    await screen.findByRole('table');
    await userEvent.selectOptions(screen.getByLabelText('Program', { exact: true }), fixtureId);
    const rows = renderedCells(screen.getByRole('table'));
    expect(rows).toHaveLength(3); expect(rows[2]!.slice(-2)).toEqual(['0', '0']);
    await userEvent.selectOptions(screen.getByLabelText('Attendance period'), 'week');
    await waitFor(() => expect(service.attendance).toHaveBeenLastCalledWith(expect.objectContaining({ granularity: 'week' }), expect.any(AbortSignal)));
    expect((screen.getByLabelText('Program', { exact: true }) as HTMLSelectElement).value).toBe('all');
    expect(service.members).not.toHaveBeenCalled(); expect(service.revenue).not.toHaveBeenCalled();
  });
  it('retains the program filter and fresh queries across every tab switch', async () => {
    const service = client(); mount(service);
    await screen.findByRole('table');
    await userEvent.selectOptions(screen.getByLabelText('Program', { exact: true }), fixtureId);
    await choose('members'); await choose('revenue'); await choose('attendance');
    expect(screen.getByLabelText('Program', { exact: true })).toHaveProperty('value', fixtureId);
    expect(renderedCells(screen.getByRole('table'))).toHaveLength(3);
    await choose('members'); await choose('revenue');
    expect(service.attendance).toHaveBeenCalledTimes(1);
    expect(service.members).toHaveBeenCalledTimes(1);
    expect(service.revenue).toHaveBeenCalledTimes(1);
  });
  it('shows members to combined coach and front desk roles while keeping revenue hidden', async () => {
    const service = client(); mount(service, ['coach', 'front_desk']);
    await screen.findByRole('table');
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Attendance', 'Members']);
    await choose('members'); expect(service.members).toHaveBeenCalledTimes(1);
    expect(service.revenue).not.toHaveBeenCalled();
  });
  it('applies a valid inclusive 24-month range and rejects reversed or longer ranges without a request', async () => {
    const service = client(); mount(service); await screen.findByRole('table');
    const from = screen.getByLabelText('From month'), to = screen.getByLabelText('Through month');
    const submit = async (start: string, end: string) => {
      fireEvent.change(from, { target: { value: start } }); fireEvent.change(to, { target: { value: end } });
      await userEvent.click(screen.getByRole('button', { name: 'Apply range' }));
    };
    await submit('2024-01', '2025-12');
    await waitFor(() => expect(service.attendance).toHaveBeenLastCalledWith({ from: '2024-01', to: '2025-12', granularity: 'month' }, expect.any(AbortSignal)));
    const count = vi.mocked(service.attendance).mock.calls.length;
    await submit('2023-12', '2025-12'); expect(await screen.findByRole('alert')).toBeDefined();
    await submit('2025-12', '2025-01'); expect(service.attendance).toHaveBeenCalledTimes(count);
    await submit('2025-01', '2025-01'); await waitFor(() => expect(service.attendance).toHaveBeenCalledTimes(count + 1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('supports arrow, Home and End navigation between accessible tabs', async () => {
    mount(); await screen.findByRole('table');
    screen.getByRole('tab', { name: 'Attendance' }).focus();
    await userEvent.keyboard('{ArrowRight}'); expect(document.activeElement?.textContent).toBe('Members');
    await userEvent.keyboard('{End}'); expect(document.activeElement?.textContent).toBe('Revenue');
    await userEvent.keyboard('{Home}'); expect(document.activeElement?.textContent).toBe('Attendance');
  });
  it.each(['attendance', 'members', 'revenue'] as const)('shows %s error and retry without server details', async report => {
    const service = client(); vi.mocked(service[report]).mockRejectedValueOnce(new Error('private database details'));
    mount(service); await userEvent.click(screen.getByRole('tab', { name: titles[report] }));
    const error = await screen.findByRole('alert'); expect(error.textContent).not.toContain('private');
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(within(error).getByRole('button'));
    expect((await screen.findAllByRole('table')).length).toBeGreaterThan(0);
  });
  it.each(['attendance', 'members', 'revenue'] as const)('shows an empty %s response', async report => {
    const service = client();
    service.attendance = vi.fn(async () => ({ ...attendanceFixture, buckets: [] }));
    service.members = vi.fn(async () => ({ ...membersFixture, buckets: [] }));
    service.revenue = vi.fn(async () => ({ ...revenueFixture, currencies: [] }));
    mount(service); await userEvent.click(screen.getByRole('tab', { name: titles[report] }));
    expect(await screen.findByText('No activity in this range')).toBeDefined();
  });
});

describe('report access through production composition', () => {
  it.each(['owner', 'admin', 'coach', 'front_desk'] as const)('gates the registered Reports navigation for %s', role => {
    const navigation = visibleAdminNavigation(createRegistries().adminNav.all(), { userId: fixtureId, displayName: 'Staff', roles: [role], member: false }, []);
    expect(navigation.some(entry => entry.href === '/admin/reports')).toBe(role !== 'front_desk');
  });
  it.each([{ roles: ['front_desk'] }, { roles: [] }] satisfies { roles: StaffRole[] }[])('refuses direct access for roles $roles before loading any report', async ({ roles }) => {
    const attendance = vi.spyOn(reportClient, 'attendance'), members = vi.spyOn(reportClient, 'members'), revenue = vi.spyOn(reportClient, 'revenue');
    const services = createShellServices(async () => ({ gym: { id: fixtureId, name: 'Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId: fixtureId, displayName: null, roles, member: true }, login: { password: true, magicLink: false } }));
    provider(<ShellServicesContext.Provider value={services}><ReportsPage /></ShellServicesContext.Provider>);
    expect(await screen.findByText('You do not have permission to view reports.')).toBeDefined();
    expect(attendance).not.toHaveBeenCalled(); expect(members).not.toHaveBeenCalled(); expect(revenue).not.toHaveBeenCalled();
  });
  it.each(['owner', 'admin', 'coach'] as const)('loads the route page with the production client for %s and exposes only permitted tabs', async role => {
    const attendance = vi.spyOn(reportClient, 'attendance').mockResolvedValue(attendanceFixture);
    const members = vi.spyOn(reportClient, 'members').mockResolvedValue(membersFixture);
    const revenue = vi.spyOn(reportClient, 'revenue').mockResolvedValue(revenueFixture);
    const services = createShellServices(async () => ({ gym: { id: fixtureId, name: 'Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId: fixtureId, displayName: null, roles: [role], member: false }, login: { password: true, magicLink: false } }));
    provider(<ShellServicesContext.Provider value={services}><ReportsPage /></ShellServicesContext.Provider>);
    await screen.findByRole('table'); expect(attendance).toHaveBeenCalled();
    expect(screen.getAllByRole('tab')).toHaveLength(role === 'coach' ? 1 : 3);
    if (role === 'coach') { expect(members).not.toHaveBeenCalled(); expect(revenue).not.toHaveBeenCalled(); }
    else { await choose('members'); expect(members).toHaveBeenCalled(); await choose('revenue'); expect(revenue).toHaveBeenCalled(); }
  });
});
