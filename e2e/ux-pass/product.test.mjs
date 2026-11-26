// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { captureClockInstant } from './product.mjs';

for (const [now, instant] of [
  ['2026-11-25T08:00:00Z', '2026-11-23T12:00:00.000Z'], // Wednesday
  ['2026-11-23T10:00:00Z', '2026-11-16T12:00:00.000Z'], // Monday before noon
  ['2026-11-23T12:00:00Z', '2026-11-23T12:00:00.000Z'], // Monday noon exactly
  ['2026-11-29T23:59:59Z', '2026-11-23T12:00:00.000Z'], // Sunday
  ['2027-01-01T00:00:00Z', '2026-12-28T12:00:00.000Z'], // across a year
]) {
  test(`the capture clock for ${now} is ${instant}`, () => {
    assert.equal(captureClockInstant(new Date(now)), instant);
  });
}

/** Runs the container's clock shim in its own process, since it replaces the global `Date`. */
function shim(instant) {
  const env = { ...process.env };
  delete env.CAPTURE_CLOCK_INSTANT;
  if (instant !== undefined) env.CAPTURE_CLOCK_INSTANT = instant;
  return spawnSync(process.execPath, ['--import', new URL('./product-clock.mjs', import.meta.url).href,
    '--print', 'JSON.stringify([new Date().toISOString(), Date.now()])'], { env, encoding: 'utf8' });
}

test('the clock shim freezes Date at the instant', () => {
  const result = shim('2026-11-23T12:00:00.000Z');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['2026-11-23T12:00:00.000Z', Date.parse('2026-11-23T12:00:00.000Z')]);
});

for (const instant of [undefined, '', 'next Monday']) {
  test(`the clock shim refuses ${JSON.stringify(instant) ?? 'a missing instant'}`, () => {
    const result = shim(instant);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPTURE_CLOCK_INSTANT must be an ISO instant/);
  });
}
