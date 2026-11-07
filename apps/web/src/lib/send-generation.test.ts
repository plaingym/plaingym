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
