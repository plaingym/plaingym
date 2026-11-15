// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';
import type { gyms } from '@plaingym/db';

type Gym = typeof gyms.$inferSelect;
const requestGym = new AsyncLocalStorage<{ gym: Gym; active: boolean }>();
/** A guard snapshot is scoped to one request and is never reused by another gym or background job. */
export const withDemoGym = <T>(gym: Gym, next: () => Promise<T>) => {
  const snapshot = { gym, active: true };
  return requestGym.run(snapshot, async () => {
    try { return await next(); }
    finally { snapshot.active = false; }
  });
};
export const currentDemoGym = (gymId: string) => {
  const snapshot = requestGym.getStore();
  return snapshot?.active && snapshot.gym.id === gymId ? snapshot.gym : undefined;
};
