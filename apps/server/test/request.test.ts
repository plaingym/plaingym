// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { jsonInit, requestWithLength } from './request.js';

it('frames the serialized JSON bytes, including Unicode, without serializing twice', async () => {
  const toJSON = vi.fn(() => ({ name: 'Zoë 🥋' }));
  const request = new Request('https://gym.example.test/join', { method: 'POST', ...jsonInit({ toJSON }) });
  const bytes = await request.arrayBuffer();
  expect(request.headers.get('content-type')).toBe('application/json');
  expect(Number(request.headers.get('content-length'))).toBe(bytes.byteLength);
  expect(new TextDecoder().decode(bytes)).toBe('{"name":"Zoë 🥋"}');
  expect(toJSON).toHaveBeenCalledTimes(1);
});

it('frames raw malformed JSON without making it valid', async () => {
  const request = await requestWithLength('https://gym.example.test/join', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid json',
  });
  expect(await request.text()).toBe('{invalid json');
  expect(request.headers.get('content-length')).toBe('13');
});
