// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FakeKioskStandingCheck } from '../../../core/interfaces/extensions.js';
import { TestClock } from '../../../core/clock.js';
import { createStandingChecks } from './standing.js';

const context = { gymId: '00000000-0000-7000-8000-000000000001', memberId: '00000000-0000-7000-8000-000000000002', clock: new TestClock('2026-10-22T18:00:00Z') };
describe('kiosk standing providers', () => {
  it('accepts additional providers without changing the evaluator and preserves staff reasons', async () => {
    const extra = new FakeKioskStandingCheck('test-extension');
    const standing = createStandingChecks([extra]);
    expect(await standing.evaluate(context)).toEqual({ status: 'ok', reasons: [] });
    extra.set(context.gymId, context.memberId, { status: 'front_desk', reasonCode: 'extension-check' });
    expect(await standing.evaluate(context)).toEqual({ status: 'front_desk', reasons: ['extension-check'] });
    expect(await standing.evaluate({ ...context, gymId: '00000000-0000-7000-8000-000000000003' })).toEqual({ status: 'ok', reasons: [] });
  });
  it('fails closed on rejected and synchronously throwing providers without exposing their errors', async () => {
    const standing = createStandingChecks([
      { id: 'rejected', async check() { throw new Error('past due $123.45'); } },
      { id: 'throws', check() { throw new Error('private provider details'); } },
    ]);
    expect(await standing.evaluate(context)).toEqual({ status: 'front_desk', reasons: ['unavailable', 'unavailable'] });
  });
});
