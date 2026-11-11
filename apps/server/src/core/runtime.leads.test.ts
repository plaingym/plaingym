// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { factory } = app;

type Widget = { id: string; count?: number; items?: { label: string; href: string }[] };

it('shows the follow-ups due tile on the dashboard through the runtime, listing a due lead and linking to its page', async () => {
  const sandbox = app.sandbox, cookie = await app.login('owner'), headers = app.headers(sandbox, cookie);
  const read = async () => {
    const response = await app.runtime.app.request(sandbox.origin + '/api/dashboard', { headers });
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()).data.widgets as Widget[]).find(widget => widget.id === 'leads.follow-ups-due');
  };
  const before = (await read())?.count ?? 0;
  const member = await factory('members', sandbox.gymId, { status: 'prospect' });
  await factory('leads', sandbox.gymId, { memberId: member.id, stage: 'new', nextFollowUpOn: '2000-01-01' });
  const tile = await read();
  expect(tile, 'the runtime passes the follow-ups provider to configureDashboard').toBeDefined();
  expect(tile!.count).toBe(before + 1);
  expect(tile!.items).toEqual(expect.arrayContaining([expect.objectContaining({ href: `/admin/leads/${member.id}` })]));
}, 90_000);
