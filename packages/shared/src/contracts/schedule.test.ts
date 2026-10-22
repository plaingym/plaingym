// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { classSessions, classTags, classTemplates } from '../../../db/src/schema/index.js';
import { canStaff, isRoutePermission } from '../permissions.js';
import {
  classSessionListQuerySchema, classSessionSchema, classTagSchema, classTemplateSchema,
  createClassSessionRequestSchema, createClassTemplateRequestSchema, scheduleContracts,
  scheduleRevisionRequestSchema, updateClassSessionRequestSchema, updateClassTagRequestSchema,
  updateClassTemplateRequestSchema, updateSessionCapacityRequestSchema,
  type ClassSession, type ClassTag, type ClassTemplate,
} from '@plaingym/shared/contracts';

const id = '019a08bf-1234-7000-8000-000000000001';
const otherId = '019a08bf-1234-7000-8000-000000000002';
const createdAt = '2026-10-21T12:00:00Z';
const template = {
  name: 'Evening class', weekday: 0, localStartTime: '01:30', durationMinutes: 60,
  coachId: null, capacity: null, notes: null, programIds: [id], tagIds: [],
};
const session = {
  name: 'Evening class', startsAt: '2026-11-01T01:30:00-07:00', endsAt: '2026-11-01T01:30:00-08:00',
  coachId: null, capacity: null, notes: null, programIds: [id], tagIds: [],
};

describe('weekly templates and materialized sessions', () => {
  it('preserves local wall time and accepts the repeated DST hour as a positive duration', () => {
    expect(createClassTemplateRequestSchema.parse(template)).toEqual(template);
    expect(createClassSessionRequestSchema.parse(session)).toEqual(session);
    expect(createClassTemplateRequestSchema.parse({ ...template, weekday: 6, localStartTime: '23:59' }).weekday).toBe(6);
  });
  it.each(['24:00', '12:60', '1:30', '01:30:00', '01:30Z', ' 01:30'])('rejects invalid local time %s', (localStartTime) => {
    expect(createClassTemplateRequestSchema.safeParse({ ...template, localStartTime }).success).toBe(false);
  });
  it.each([-1, 7, 1.5, '1'])('rejects weekday %j', (weekday) => {
    expect(createClassTemplateRequestSchema.safeParse({ ...template, weekday }).success).toBe(false);
  });
  it.each([0, -1, 0.5, 2_147_483_648, '30'])('rejects invalid duration/capacity %j', (value) => {
    expect(createClassTemplateRequestSchema.safeParse({ ...template, durationMinutes: value }).success).toBe(false);
    expect(createClassTemplateRequestSchema.safeParse({ ...template, capacity: value }).success).toBe(false);
    expect(updateSessionCapacityRequestSchema.safeParse({ capacity: value, revision: 1 }).success).toBe(false);
  });
  it('requires programs, unique mapping IDs, and positive capacity or null', () => {
    for (const change of [{ programIds: [] }, { programIds: [id, id] }, { tagIds: [id, id] }, { coachId: 'coach-1' }]) {
      expect(createClassTemplateRequestSchema.safeParse({ ...template, ...change }).success).toBe(false);
      expect(createClassSessionRequestSchema.safeParse({ ...session, ...change }).success).toBe(false);
    }
    expect(createClassSessionRequestSchema.parse({ ...session, capacity: 1 }).capacity).toBe(1);
    expect(updateSessionCapacityRequestSchema.parse({ capacity: null, revision: 2 }).capacity).toBeNull();
  });
  it('compares session instants rather than their wall-time strings', () => {
    for (const endsAt of [session.startsAt, '2026-11-01T01:45:00-06:00']) {
      expect(createClassSessionRequestSchema.safeParse({ ...session, endsAt }).success).toBe(false);
      expect(updateClassSessionRequestSchema.safeParse({ ...session, endsAt, revision: 1 }).success).toBe(false);
    }
    expect(classSessionSchema.safeParse({ ...session, id, templateId: null, createdAt, revision: 1, status: 'deleted' }).success).toBe(false);
  });
  it('accepts full replacement edits only with the revision read by the client', () => {
    for (const [schema, body] of [
      [updateClassTagRequestSchema, { name: 'Open training' }],
      [updateClassTemplateRequestSchema, template], [updateClassSessionRequestSchema, session],
    ] as const) {
      expect(schema.safeParse(body).success).toBe(false);
      for (const revision of [0, -1, 1.5, '1']) expect(schema.safeParse({ ...body, revision }).success).toBe(false);
      expect(schema.safeParse({ ...body, revision: 2 }).success).toBe(true);
    }
    expect(scheduleRevisionRequestSchema.safeParse({}).success).toBe(false);
  });
  it('rejects missing revisions on every schedule mutation that edits or deletes a record', () => {
    for (const endpoint of [scheduleContracts.updateTag, scheduleContracts.deleteTag, scheduleContracts.updateTemplate,
      scheduleContracts.deleteTemplate, scheduleContracts.updateSession, scheduleContracts.cancelSession,
      scheduleContracts.swapCoach, scheduleContracts.updateNotes, scheduleContracts.updateCapacity]) {
      expect(endpoint.body.safeParse({}).success).toBe(false);
    }
    expect(classTagSchema.safeParse({ id, name: 'Open', createdAt }).success).toBe(false);
    expect(classTemplateSchema.safeParse({ ...template, id, createdAt }).success).toBe(false);
  });
  it('rejects authority and server-owned fields in create requests', () => {
    for (const extra of [{ gymId: otherId }, { id }, { revision: 1 }, { templateId: id }, { status: 'cancelled' }]) {
      expect(createClassSessionRequestSchema.safeParse({ ...session, ...extra }).success).toBe(false);
    }
  });
  it('extends strict offset pagination with real schedule filters and a forward interval', () => {
    const query = { from: session.startsAt, until: session.endsAt, programId: id, tagId: otherId };
    expect(classSessionListQuerySchema.parse(query)).toMatchObject({ ...query, limit: 50, offset: 0 });
    expect(classSessionListQuerySchema.parse({ ...query, limit: '10', offset: '5' })).toMatchObject({ limit: 10, offset: 5 });
    expect(classSessionListQuerySchema.safeParse({ ...query, until: query.from }).success).toBe(false);
    expect(classSessionListQuerySchema.safeParse({ ...query, limit: 101 }).success).toBe(false);
    expect(classSessionListQuerySchema.safeParse({ ...query, gymId: otherId }).success).toBe(false);
  });
  it('keeps staff fields aligned with the locked database columns', () => {
    type TemplateRow = typeof classTemplates.$inferSelect;
    type SessionRow = typeof classSessions.$inferSelect;
    type TagRow = typeof classTags.$inferSelect;
    expectTypeOf<Omit<ClassTemplate, 'programIds' | 'tagIds' | 'createdAt'>>()
      .toExtend<Omit<TemplateRow, 'gymId' | 'createdAt'>>();
    expectTypeOf<Omit<ClassSession, 'programIds' | 'tagIds' | 'createdAt' | 'startsAt' | 'endsAt'>>()
      .toExtend<Omit<SessionRow, 'gymId' | 'createdAt' | 'startsAt' | 'endsAt'>>();
    expectTypeOf<Omit<ClassTag, 'createdAt'>>().toExtend<Omit<TagRow, 'gymId' | 'createdAt'>>();
  });
  it('lets all staff read schedules and edit notes; only scheduling roles change sessions', () => {
    for (const endpoint of Object.values(scheduleContracts)) {
      expect(isRoutePermission(endpoint.permission)).toBe(true);
      for (const role of ['owner', 'admin', 'coach'] as const) expect(canStaff([role], endpoint.permission.capability)).toBe(true);
      expect(canStaff([], endpoint.permission.capability)).toBe(false);
      const deskAllowed = endpoint.method === 'get' || endpoint.path.endsWith('/notes');
      expect(canStaff(['front_desk'], endpoint.permission.capability)).toBe(deskAllowed);
    }
    expect(Object.values(scheduleContracts).some((endpoint) => endpoint.method === 'delete' && endpoint.path.includes('/sessions'))).toBe(false);
  });
});
