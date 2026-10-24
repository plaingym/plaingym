// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, Client } from '../support.js';

// Exports report a signed link to their archive. On the single-gym install (local disk storage)
// that link is served by the app itself, so this follows it through Caddy end to end.
test('an owner downloads a finished export through its signed link, and a tampered link is refused', async ({ install }) => {
  const owner = install.clients.owner;
  const created = await owner.json<{ data: { id: string } }>('/api/exports', 'POST', { format: 'csv' });
  let job: { status: string; downloadUrl: string | null } = { status: 'pending', downloadUrl: null };
  await expect.poll(async () => {
    job = (await owner.json<{ data: typeof job }>(`/api/exports/${created.data.id}`)).data;
    return job.status;
  }, { timeout: 60_000 }).toBe('succeeded');
  const url = new URL(job.downloadUrl!);
  expect(url.pathname).toBe('/api/uploads/download');
  // The signature is the credential: a client without a session can follow the link.
  const anonymous = new Client(url.origin);
  const archive = await anonymous.request(url.pathname + url.search);
  expect(archive.status, archive.text.slice(0, 200)).toBe(200);
  expect(archive.text.startsWith('PK')).toBe(true);
  url.searchParams.set('signature', 'A'.repeat(43));
  expect((await anonymous.request(url.pathname + url.search)).status).toBe(404);
});
