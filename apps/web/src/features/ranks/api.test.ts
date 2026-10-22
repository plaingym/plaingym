// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createRanksClient, allPages } from './api.js';

const id = '019a0af0-9c00-7000-8000-000000000001';
describe('ranks contract client', () => {
  it('fetches every page rather than silently truncating a roster', async () => {
    const load = vi.fn(async (offset: number) => ({ data: offset ? ['last'] : ['first', 'second'], pagination: { limit: 2, offset, total: 3 } }));
    expect(await allPages(load)).toEqual(['first', 'second', 'last']);
    expect(load.mock.calls).toEqual([[0], [2]]);
    await expect(allPages(async () => ({ data: [], pagination: { limit: 1, offset: 0, total: 1 } }))).rejects.toThrow();
  });
  it('validates staff edits and carries revisions over a same-origin PATCH', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { id, gymId: id, rankSystemId: id, createdAt: '2026-10-22T12:00:00Z',
      name: 'Our rank', position: 0, color: '#123abc', subRanks: [], criteria: [], revision: 2 } }));
    const client = createRanksClient(fetcher);
    await client.call('updateRank', { revision: 1, name: 'Our rank', color: '#123abc' }, id);
    expect(fetcher).toHaveBeenCalledWith('/api/ranks/' + id, expect.objectContaining({ method: 'PATCH', credentials: 'same-origin', redirect: 'error',
      body: JSON.stringify({ name: 'Our rank', color: '#123abc', revision: 1 }) }));
    await expect(client.call('updateRank', { name: 'Missing revision' }, id)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps server messages out of errors and rejects malformed success responses', async () => {
    const client = createRanksClient(vi.fn(async () => Response.json({ error: { message: 'Private SQL' } }, { status: 409 })));
    await expect(client.call('createRankSystem', { name: 'System' })).rejects.toMatchObject({ status: 409, message: 'Request failed' });
    await expect(createRanksClient(vi.fn(async () => Response.json({ data: 'bad' }))).systems()).rejects.toThrow();
  });
});
