// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createIntakeRateLimitStore } from './rate-limit-store.js';
import { cacheRefusals } from './rate-limit.js';
import { createPublicIntakeCeiling, publicIntakeLimits } from './rate-limit-intake.js';
import { setLogSink } from './log.js';

const db = useTestDatabase(), factory = createFactories(db);
it('atomically caps participants across processes, isolates gyms and resets the hour', async () => {
  const gymId = uuidv7(), otherGym = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const first = createPublicIntakeCeiling({ store: createIntakeRateLimitStore(db.forSystem), participants: 10 });
  const second = createPublicIntakeCeiling({ store: createIntakeRateLimitStore(db.forSystem), participants: 10 });
  const input = { gymId, now: 0, participants: 1, signatureBytes: 0 };
  const replies = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => (i % 2 ? first : second)(input)));
  expect(replies.filter(r => r.status === 'fulfilled')).toHaveLength(10);
  expect(replies.filter(r => r.status === 'rejected')).toHaveLength(14);
  await expect(first({ ...input, gymId: otherGym })).resolves.toBeUndefined();
  await expect(second({ ...input, now: publicIntakeLimits.windowMs - 1 })).rejects.toMatchObject({ code: 'rate_limited' });
  await expect(second({ ...input, now: publicIntakeLimits.windowMs })).resolves.toBeUndefined();
});

it('counts decoded bytes rounded up to KiB and a refused large reservation leaves room for a smaller one', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const ceiling = () => createPublicIntakeCeiling({ store: cacheRefusals(createIntakeRateLimitStore(db.forSystem)), signatureKiB: 4 });
  const input = { gymId, now: 0, participants: 1, signatureBytes: 1025 };
  await ceiling()(input); // Two KiB.
  await expect(ceiling()({ ...input, signatureBytes: 2049 })).rejects.toMatchObject({ code: 'rate_limited' });
  await expect(ceiling()(input)).resolves.toBeUndefined(); // Exactly four KiB across independent stores.
  await expect(ceiling()({ ...input, signatureBytes: 1 })).rejects.toMatchObject({ code: 'rate_limited' });
});

it('does not cache a weighted refusal and logs the spent resource once per gym and hour', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const reserve = createPublicIntakeCeiling({ store: cacheRefusals(createIntakeRateLimitStore(db.forSystem)), participants: 3 });
  const input = { gymId, now: 0, participants: 2, signatureBytes: 0 };
  const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
  try {
    await reserve(input);
    await expect(reserve(input)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(reserve({ ...input, participants: 1 })).resolves.toBeUndefined();
    await expect(reserve(input)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(lines.map(line => JSON.parse(line))).toMatchObject([{ event: 'public.intake.ceiling_reached', gymId, resource: 'participants', limit: 3 }]);
    await reserve({ ...input, now: publicIntakeLimits.windowMs });
    await expect(reserve({ ...input, now: publicIntakeLimits.windowMs })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(lines).toHaveLength(2);
  } finally { setLogSink(previous); }
});
