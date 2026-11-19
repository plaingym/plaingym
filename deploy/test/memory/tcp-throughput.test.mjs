// SPDX-License-Identifier: AGPL-3.0-only
// node --test deploy/test/memory/tcp-throughput.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeThroughput, throughputFloorMegabytesPerSecond } from './tcp-throughput.mjs';

test('the download throughput floor stays at 3 MB/s', () => {
  assert.equal(throughputFloorMegabytesPerSecond, 3);
});

test('the best of three downloads decides the floor', () => {
  assert.deepEqual(judgeThroughput([2.94, 1.2, 3.05]), { best: 3.05, floor: 3, pass: true });
  assert.deepEqual(judgeThroughput([2.99, 1.5, 2.2]), { best: 2.99, floor: 3, pass: false });
  // Exactly the floor passes, as it did when one download was judged.
  assert.deepEqual(judgeThroughput([3, 2, 1]), { best: 3, floor: 3, pass: true });
});

test('no measured download cannot pass the floor', () => {
  assert.deepEqual(judgeThroughput([]), { best: 0, floor: 3, pass: false });
});
