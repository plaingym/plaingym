// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { stripeEvents } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0036_announcement_sms', { applySecurity: true });

it('adds inbox recovery indexes to a populated database without changing stored events', async () => {
  const gymId = uuidv7(), maintenance = openConnection(database.maintenanceUrl, 1);
  const receivedAt = new Date('2026-11-17T09:00:00Z');
  const payload = { type: 'payment_intent.succeeded' };
  const events = [
    { id: uuidv7(1), eventId: 'evt_pending', processedAt: null, error: null },
    { id: uuidv7(2), eventId: 'evt_failed', processedAt: null, error: 'handler_failed' },
    { id: uuidv7(3), eventId: 'evt_processed', processedAt: receivedAt, error: null },
  ];
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Inbox upgrade', ${gymId})`;
    for (const event of events) await maintenance.sql`
      insert into stripe_events (id, event_id, gym_id, type, payload, received_at, processed_at, error)
      values (${event.id}, ${event.eventId}, ${gymId}, ${payload.type}, ${JSON.stringify(payload)}::jsonb,
        ${receivedAt.toISOString()}, ${event.processedAt?.toISOString() ?? null}, ${event.error})`;
    await migrateDatabase(database.maintenanceUrl);
    const rows = await database.forGym(gymId, tx => tx.select().from(stripeEvents).orderBy(stripeEvents.id));
    expect(rows).toMatchObject(events.map(event => ({ ...event, gymId, payload, type: payload.type, receivedAt })));
    const indexes = await maintenance.sql`select indexname from pg_indexes where tablename = 'stripe_events'
      and indexname in ('stripe_events_recovery_error_idx', 'stripe_events_recovery_no_error_idx') order by indexname`;
    expect(indexes).toEqual([{ indexname: 'stripe_events_recovery_error_idx' }, { indexname: 'stripe_events_recovery_no_error_idx' }]);
  } finally { await maintenance.close(); }
});
