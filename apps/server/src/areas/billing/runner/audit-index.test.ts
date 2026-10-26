// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';

const db = useTestDatabase(), factory = createFactories(db);
it('installs the generated action/target index while preserving tenant-isolated audit reads', async () => {
  const gym = uuidv7(), other = uuidv7(), targetId = uuidv7(), action = 'billing.transition.effect.created';
  await factory('gyms', gym); await factory('gyms', other);
  await factory('auditEvents', gym, { action, targetId }); await factory('auditEvents', other, { action, targetId });
  const rows = await db.forGym(gym, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId))));
  expect(rows).toHaveLength(1); expect(rows[0]!.gymId).toBe(gym);
  const indexes = await db.app.sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'audit_events_gym_action_target_idx'`;
  expect(indexes).toHaveLength(1); expect(indexes[0]!.indexdef).toContain('(gym_id, action, target_id)');
});
