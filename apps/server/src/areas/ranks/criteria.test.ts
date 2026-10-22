// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { FakeAttendanceQueries } from '../../core/interfaces/attendance.js';
import { FakePromotionCriterionProvider, type CriterionContext } from '../../core/interfaces/extensions.js';
import { TestClock } from '../../core/clock.js';
import { createPromotionCriteria } from './criteria.js';

const gymId = uuidv7(), memberId = uuidv7(), programId = uuidv7(), rankId = uuidv7();
const context: CriterionContext = { gymId, memberId, programId, rankId,
  attendanceScope: { kind: 'gym', gymId }, promotedAt: '2026-10-01T12:00:00Z', dateOfBirth: '2010-10-23',
  clock: new TestClock('2026-10-22T12:00:00Z') };
const criterion = (providerId: string, target: number) => ({ providerId, config: { target } });
describe('promotion criterion providers', () => {
  it('counts only this gym, member, program and promotion window through AttendanceQueries', async () => {
    const attendance = new FakeAttendanceQueries([
      ['2026-09-30T12:00:00Z', gymId, memberId, programId],
      ['2026-10-01T12:00:00Z', gymId, memberId, programId],
      ['2026-10-21T12:00:00Z', gymId, memberId, programId],
      ['2026-10-22T12:00:00Z', gymId, memberId, programId],
      ['2026-10-21T12:00:00Z', uuidv7(), memberId, programId],
      ['2026-10-21T12:00:00Z', gymId, uuidv7(), programId],
      ['2026-10-21T12:00:00Z', gymId, memberId, uuidv7()],
    ].map(([occurredAt, owner, person, program]) => ({ gymId: owner!,
      entry: { id: uuidv7(), occurredAt: occurredAt!, memberId: person!, programId: program!, sessionId: null, source: 'import' },
      sessionProgramIds: [], sessionTagIds: [] })));
    const [result] = await createPromotionCriteria(attendance).evaluate(context, [criterion('classes-since-promotion', 3)], new Set());
    expect(result).toMatchObject({ current: 2, target: 3, met: false });
  });
  it('uses full elapsed days and completed birthdays, including unknown dates', async () => {
    const registry = createPromotionCriteria(new FakeAttendanceQueries());
    const evaluate = (ctx: CriterionContext) => registry.evaluate(ctx, [criterion('time-at-rank', 21), criterion('minimum-age', 16)], new Set());
    expect(await evaluate(context)).toMatchObject([{ current: 21, met: true }, { current: 15, met: false }]);
    expect(await evaluate({ ...context, clock: new TestClock('2026-10-23T12:00:00Z') }))
      .toMatchObject([{ current: 22, met: true }, { current: 16, met: true }]);
    expect(await evaluate({ ...context, promotedAt: null, dateOfBirth: null }))
      .toMatchObject([{ current: 0, met: false }, { current: 0, met: false }]);
  });
  it('accepts a fake module provider with prototype methods, scoped to enabled modules', async () => {
    const registry = createPromotionCriteria(new FakeAttendanceQueries());
    const provider = Object.assign(new FakePromotionCriterionProvider('skills', 'skills:completed'), { moduleId: 'skills' });
    provider.setProgress(context, 5); registry.register(provider);
    expect(await registry.evaluate(context, [criterion('skills', 4)], new Set(['skills'])))
      .toEqual([{ providerId: 'skills', labelKey: 'skills:completed', current: 5, target: 4, met: true }]);
    await expect(registry.evaluate(context, [criterion('skills', 4)], new Set())).rejects.toMatchObject({ code: 'conflict' });
    expect(() => registry.register(provider)).toThrow(/Duplicate/);
  });
  it('fails closed for unknown providers, invalid configs and invalid provider results', async () => {
    const registry = createPromotionCriteria(new FakeAttendanceQueries());
    expect(() => registry.validate([criterion('unknown', 1)])).toThrow();
    expect(() => registry.validate([criterion('minimum-age', -1)])).toThrow();
    registry.register({ id: 'broken', labelKey: 'broken', configSchema: new FakePromotionCriterionProvider('config', 'config').configSchema,
      evaluate: async () => ({ current: Infinity, target: 1, met: true }) });
    await expect(registry.evaluate(context, [criterion('broken', 1)], new Set())).rejects.toMatchObject({ code: 'conflict' });
  });
});
