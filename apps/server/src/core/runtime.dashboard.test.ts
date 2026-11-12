// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true });

type Widget = { id: string; status?: string; count?: number };

it('serves the not-seen widget through the runtime, so the runtime passes the scoped read to the dashboard', async () => {
  const sandbox = app.sandbox, cookie = await app.login('owner');
  const response = await app.runtime.app.request(sandbox.origin + '/api/dashboard', { headers: app.headers(sandbox, cookie) });
  expect(response.status, await response.clone().text()).toBe(200);
  const widget = ((await response.json()).data.widgets as Widget[]).find(item => item.id === 'not_seen');
  expect(widget, 'the dashboard lists the not-seen widget').toBeDefined();
  expect(widget!.status).toBe('ready');
  expect(widget!.count).toEqual(expect.any(Number));
}, 90_000);
