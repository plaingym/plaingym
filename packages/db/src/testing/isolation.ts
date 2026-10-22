// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from 'vitest';
/** Route tests pass requests as closures so the helpers do not depend on a web framework. */
export async function expectCrossGymDenied(requestAsOtherGym: () => Promise<Response>) {
  expect((await requestAsOtherGym()).status).toBe(404);
}
export async function expectCrossHouseholdDenied(requestAsOtherHousehold: () => Promise<Response>) {
  expect([403, 404]).toContain((await requestAsOtherHousehold()).status);
}
