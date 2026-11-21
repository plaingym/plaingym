// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { releaseUndisclosed } from './deliveries.js';

it('revokes every credential and still releases after a failed revocation', async () => {
  const calls: string[] = [], a = new Error('A');
  const error = await releaseUndisclosed([
    async () => { calls.push('first'); throw a; },
    async () => { calls.push('second'); },
  ], async () => { calls.push('release'); }, 'Cleanup failed').catch((caught: unknown) => caught);
  expect(calls).toEqual(['first', 'second', 'release']);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).message).toBe('Cleanup failed');
  expect((error as AggregateError).errors).toEqual([a]);
});

it('resolves when every revocation and the release succeed', async () => {
  await expect(releaseUndisclosed([async () => undefined, async () => undefined], async () => undefined, 'Cleanup failed')).resolves.toBeUndefined();
});

it('reports a failed release', async () => {
  const b = new Error('B');
  const error = await releaseUndisclosed([async () => undefined, async () => undefined], async () => { throw b; }, 'Cleanup failed')
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([b]);
});
