// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true });

it('mounts the waiver document read with delivery wired, so a forged token is a plain 404', async () => {
  const sandbox = app.sandbox;
  // Without `documentDelivery` the route throws "not configured" and answers 503.
  const response = await app.runtime.app.request(sandbox.origin + '/api/waivers/template-document?token=forged', { headers: app.headers(sandbox) });
  expect(response.status).toBe(404);
});

it('lets a waiver PDF past the default 1 MiB body cap to the upload handler', async () => {
  const sandbox = app.sandbox, headers = app.headers(sandbox, await app.login('owner'));
  const body = new Uint8Array(2 * 1024 * 1024);
  const response = await app.runtime.app.request(sandbox.origin + '/api/waivers/template-documents', { method: 'POST',
    headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/pdf', 'content-length': String(body.length) }, body });
  // The demo refuses uploads in the handler; the global cap would answer 413 before it.
  expect(response.status).not.toBe(413);
  expect((await response.json() as { error?: { message?: string } }).error?.message).toMatch(/upload/i);
});
