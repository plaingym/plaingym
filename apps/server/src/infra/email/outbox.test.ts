// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { emailOutbox, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { OutboxEmail } from './outbox.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymId = uuidv7(), clock = new TestClock('2026-11-09T12:00:00Z');
const message = { to: 'member@example.test', subject: 'Gym update', html: '<p>Update</p>', text: 'Update',
  listUnsubscribe: 'https://gym.example.test/l/token' };

it('captures demo content without persisting transport unsubscribe headers', async () => {
  await factory('gyms', gymId);
  const email = new OutboxEmail(gymId, clock, database.forGym);
  await expect(email.sendEmail(message)).resolves.toMatchObject({ status: 'sent' });
  const rows = await database.forGym(gymId, tx => tx.select().from(emailOutbox));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ recipient: message.to, subject: message.subject, html: message.html, text: message.text });
  expect(JSON.stringify(rows)).not.toContain(message.listUnsubscribe);
});

it('rejects invalid unsubscribe metadata before beginning an outbox transaction', async () => {
  let called = false;
  const email = new OutboxEmail(gymId, clock, (async () => { called = true; throw new Error('Unexpected transaction'); }) as typeof database.forGym);
  await expect(email.sendEmail({ ...message, listUnsubscribe: 'https://gym.example.test/l/token\nInjected: value' }))
    .rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(called).toBe(false);
});
