// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createSendGeneration } from './send-generation.js';

it('keeps a generation while a request is retried', () => {
  const sends = createSendGeneration(), request = { email: 'coach@example.test', role: 'coach' };
  expect(sends.for({ ...request })).toBe(sends.for({ ...request }));
});
it('picks a new generation for a changed request', () => {
  const sends = createSendGeneration();
  expect(sends.for({ email: 'coach@example.test' })).not.toBe(sends.for({ email: 'other@example.test' }));
});
it('picks a new generation for a deliberate resend after a send went through', () => {
  const sends = createSendGeneration(), first = sends.for('invoice');
  sends.sent();
  expect(sends.for('invoice')).not.toBe(first);
});

it('reuses every pending request after a reload, and clears only a confirmed request', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const first = createSendGeneration('invitation', storage), request = { householdId: 'home', email: 'payer@example.test' };
  const generation = first.for(request), other = first.for({ ...request, householdId: 'other' });
  const reloaded = createSendGeneration('invitation', storage);
  expect(reloaded.for(request)).toBe(generation);
  expect(createSendGeneration('staff', storage).for(request)).not.toBe(generation);
  reloaded.sent();
  expect(createSendGeneration('invitation', storage).for(request)).not.toBe(generation);
  expect(createSendGeneration('invitation', storage).for({ ...request, householdId: 'other' })).toBe(other);
});
it('keeps retrying in memory when session storage is unavailable', () => {
  const fail = () => { throw new Error('Storage denied'); };
  const sends = createSendGeneration('blocked-storage', { getItem: fail, setItem: fail, removeItem: fail });
  const first = sends.for('request');
  expect(sends.for('request')).toBe(first);
  sends.sent();
  expect(sends.for('request')).not.toBe(first);
});
