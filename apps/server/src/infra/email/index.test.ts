// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { FakeEmail } from './index.js';

const message = { to: 'member@example.test', subject: 'Gym update', html: '<p>Update</p>', text: 'Update',
  listUnsubscribe: 'https://gym.example.test/l/token' };

it('records unsubscribe metadata and keeps captured messages independent of callers', async () => {
  const email = new FakeEmail(), input = { ...message };
  await email.sendEmail(input);
  input.listUnsubscribe = 'https://changed.example.test/';
  expect(email.messages).toEqual([message]);
});

it.each(['https://gym.example.test/l/token\rInjected: value', 'https://gym.example.test/l/token\nInjected: value',
  'http://gym.example.test/l/token'])('refuses invalid unsubscribe metadata without recording (%#)', async listUnsubscribe => {
  const email = new FakeEmail();
  await expect(email.sendEmail({ ...message, listUnsubscribe })).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(email.messages).toEqual([]);
});
