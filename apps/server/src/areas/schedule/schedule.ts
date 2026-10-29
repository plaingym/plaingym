// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, ilike, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { forGym, classTags, classTemplates, classTemplatePrograms, classTemplateTags, classSessions, classSessionPrograms, classSessionTags, programs, staffProfiles, revisionGuard, assertRevised, writeAudit, RevisionConflictError, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { classTagSchema, classTemplateSchema, classSessionSchema, createClassTagRequestSchema, updateClassTagRequestSchema, createClassTemplateRequestSchema, updateClassTemplateRequestSchema, createClassSessionRequestSchema, updateClassSessionRequestSchema, classTagListQuerySchema, classTemplateListQuerySchema, classSessionListQuerySchema, scheduleRevisionRequestSchema, swapSessionCoachRequestSchema, updateSessionNotesRequestSchema, updateSessionCapacityRequestSchema,
  type ClassTemplate, type ClassSession, type CreateClassTagRequest, type UpdateClassTagRequest, type CreateClassTemplateRequest, type UpdateClassTemplateRequest, type CreateClassSessionRequest, type UpdateClassSessionRequest, type ClassTagListQuery, type ClassTemplateListQuery, type ClassSessionListQuery, type ScheduleRevisionRequest, type SwapSessionCoachRequest, type UpdateSessionNotesRequest, type UpdateSessionCapacityRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { localDate, occurrences } from './schedule.time.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { reconcileSessionBookings } from '../bookings/bookings.rules.js';

function missing(): never { throw new AppError('not_found', 'Schedule record not found'); }
const conflict = (): never => { throw new AppError('conflict', 'The schedule record is in use'); };
type TemplateRow = typeof classTemplates.$inferSelect;
type SessionRow = typeof classSessions.$inferSelect;
const tagView = (row: typeof classTags.$inferSelect) => classTagSchema.parse({ id: row.id, name: row.name, revision: row.revision, createdAt: row.createdAt.toISOString() });
async function templateView(tx: Transaction, row: TemplateRow): Promise<ClassTemplate> {
  const programIds = (await tx.select({ id: classTemplatePrograms.programId }).from(classTemplatePrograms).where(eq(classTemplatePrograms.templateId, row.id)).orderBy(asc(classTemplatePrograms.programId))).map((value) => value.id);
  const tagIds = (await tx.select({ id: classTemplateTags.tagId }).from(classTemplateTags).where(eq(classTemplateTags.templateId, row.id)).orderBy(asc(classTemplateTags.tagId))).map((value) => value.id);
  return classTemplateSchema.parse({ id: row.id, name: row.name, weekday: row.weekday, localStartTime: row.localStartTime,
    durationMinutes: row.durationMinutes, coachId: row.coachId, capacity: row.capacity, notes: row.notes, kind: row.kind,
    revision: row.revision, createdAt: row.createdAt.toISOString(), programIds, tagIds });
}
async function sessionView(tx: Transaction, row: SessionRow): Promise<ClassSession> {
  const programIds = (await tx.select({ id: classSessionPrograms.programId }).from(classSessionPrograms).where(eq(classSessionPrograms.sessionId, row.id)).orderBy(asc(classSessionPrograms.programId))).map((value) => value.id);
  const tagIds = (await tx.select({ id: classSessionTags.tagId }).from(classSessionTags).where(eq(classSessionTags.sessionId, row.id)).orderBy(asc(classSessionTags.tagId))).map((value) => value.id);
  return classSessionSchema.parse({ id: row.id, name: row.name, templateId: row.templateId, status: row.status,
    coachId: row.coachId, capacity: row.capacity, notes: row.notes, kind: row.kind, revision: row.revision,
    createdAt: row.createdAt.toISOString(), startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), programIds, tagIds });
}
async function relationships(tx: Transaction, input: { programIds: string[]; tagIds: string[]; coachId: string | null }) {
  // Resolve IDs before writing so forged references receive the same 404 as an absent resource.
  const found = await tx.select({ id: programs.id }).from(programs).where(inArray(programs.id, input.programIds));
  if (found.length !== input.programIds.length) missing();
  if (input.tagIds.length) {
    const tags = await tx.select({ id: classTags.id }).from(classTags).where(inArray(classTags.id, input.tagIds));
    if (tags.length !== input.tagIds.length) missing();
  }
  if (input.coachId && !(await tx.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.id, input.coachId))).length) missing();
}
async function mappings(tx: Transaction, kind: 'template' | 'session', gymId: string, id: string, input: { programIds: string[]; tagIds: string[] }, createdAt: Date) {
  if (kind === 'template') {
    await tx.delete(classTemplatePrograms).where(eq(classTemplatePrograms.templateId, id));
    await tx.delete(classTemplateTags).where(eq(classTemplateTags.templateId, id));
    if (input.programIds.length) await tx.insert(classTemplatePrograms).values(input.programIds.map((programId) => ({ gymId, templateId: id, programId, createdAt })));
    if (input.tagIds.length) await tx.insert(classTemplateTags).values(input.tagIds.map((tagId) => ({ gymId, templateId: id, tagId, createdAt })));
  } else {
    await tx.delete(classSessionPrograms).where(eq(classSessionPrograms.sessionId, id));
    await tx.delete(classSessionTags).where(eq(classSessionTags.sessionId, id));
    if (input.programIds.length) await tx.insert(classSessionPrograms).values(input.programIds.map((programId) => ({ gymId, sessionId: id, programId, createdAt })));
    if (input.tagIds.length) await tx.insert(classSessionTags).values(input.tagIds.map((tagId) => ({ gymId, sessionId: id, tagId, createdAt })));
  }
}
/** Converts constraint races to safe conflicts without exposing SQL or foreign IDs. */
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? error.cause : error;
    if (typeof cause === 'object' && cause !== null && 'code' in cause) {
      if (cause.code === '23505' && 'constraint_name' in cause && cause.constraint_name === 'class_sessions_materialized_key') {
        throw new AppError('session_start_taken', 'Another session of this weekly class already starts at this time.');
      }
      if (['23503', '23505'].includes(String(cause.code))) conflict();
    }
    throw error;
  }
}
export function createScheduleService(options: { scope?: typeof forGym; clock?: Clock; settings?: GymSettingsAccessor } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? createGymSettingsAccessor({ scope });
  const audit = async (tx: Transaction, context: MutationContext, action: string, id: string, before: unknown, after: unknown) => {
    await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind, ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'schedule.' + action, targetType: 'schedule', targetId: id, before, after, occurredAt: clock.now() });
  };
  /** Generates a template's missing sessions within the horizon, in the caller's transaction. */
  async function materializeTemplate(tx: Transaction, gymId: string, id: string, timezone: string, now: Date): Promise<number> {
    const [row] = await tx.select().from(classTemplates).where(eq(classTemplates.id, id)).for('update'); if (!row) return 0;
    const template = await templateView(tx, row);
    const starts = occurrences(template, now, timezone); if (!starts.length) return 0;
    const from = new Date(now.getTime() - 172_800_000), until = new Date(starts.at(-1)!.getTime() + 172_800_000);
    // Sessions generated without a key (before it existed) were never moved, so their start is the occurrence.
    const existing = await tx.select({ startsAt: classSessions.startsAt, occurrenceStartsAt: classSessions.occurrenceStartsAt }).from(classSessions).where(and(eq(classSessions.templateId, id), or(
      and(gte(classSessions.occurrenceStartsAt, from), lt(classSessions.occurrenceStartsAt, until)),
      and(isNull(classSessions.occurrenceStartsAt), gte(classSessions.startsAt, from), lt(classSessions.startsAt, until)))));
    const dates = new Set(existing.map((session) => localDate(session.occurrenceStartsAt ?? session.startsAt, timezone)));
    let count = 0;
    for (const startsAt of starts) {
      // Template edits affect unmaterialized dates; existing sessions retain overrides.
      if (dates.has(localDate(startsAt, timezone))) continue;
      // Skip on either unique key: a retry, or a session of this template already moved to this exact start.
      const [session] = await tx.insert(classSessions).values({ gymId, templateId: id, name: template.name, startsAt, occurrenceStartsAt: startsAt, endsAt: new Date(startsAt.getTime() + template.durationMinutes * 60_000), coachId: template.coachId, capacity: template.capacity, notes: template.notes, kind: template.kind, createdAt: now })
        .onConflictDoNothing().returning();
      if (!session) continue;
      await mappings(tx, 'session', gymId, session.id, template, now);
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'schedule.session.materialized', targetType: 'class_session', targetId: session.id, after: await sessionView(tx, session), occurredAt: now });
      count++;
    }
    return count;
  }
  const service = {
    async options(gymId: string) {
      const { timezone } = await settings.get(gymId);
      return scope(gymId, async (tx) => ({
        timezone,
        programs: await tx.select({ id: programs.id, name: programs.name }).from(programs).orderBy(asc(programs.name), asc(programs.id)),
        coaches: await tx.select({ id: staffProfiles.id, name: staffProfiles.displayName }).from(staffProfiles).orderBy(asc(staffProfiles.displayName), asc(staffProfiles.id)),
      }));
    },
    async listTags(gymId: string, input: ClassTagListQuery) {
      const query = classTagListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        const where = query.search ? ilike(classTags.name, '%' + query.search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%') : undefined;
        const rows = await tx.select().from(classTags).where(where).orderBy(asc(classTags.name), asc(classTags.id)).limit(query.limit).offset(query.offset);
        return { data: rows.map(tagView), pagination: { limit: query.limit, offset: query.offset, total: await tx.$count(classTags, where) } };
      });
    },
    async createTag(context: MutationContext, input: CreateClassTagRequest) {
      const value = createClassTagRequestSchema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        const [row] = await tx.insert(classTags).values({ ...value, gymId: context.gymId, createdAt: clock.now() }).returning();
        const after = tagView(row!); await audit(tx, context, 'tag.created', after.id, null, after); return after;
      }));
    },
    async updateTag(context: MutationContext, id: string, input: UpdateClassTagRequest) {
      const { revision, ...value } = updateClassTagRequestSchema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        const [before] = await tx.select().from(classTags).where(eq(classTags.id, id)).for('update'); if (!before) missing();
        const guard = revisionGuard(classTags.revision, revision);
        const after = tagView(assertRevised(await tx.update(classTags).set({ ...value, revision: guard.next }).where(and(eq(classTags.id, id), guard.matches)).returning()));
        await audit(tx, context, 'tag.updated', id, tagView(before), after); return after;
      }));
    },
    async deleteTag(context: MutationContext, id: string, input: ScheduleRevisionRequest) {
      const { revision } = scheduleRevisionRequestSchema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        const [before] = await tx.select().from(classTags).where(eq(classTags.id, id)).for('update'); if (!before) missing();
        assertRevised(await tx.delete(classTags).where(and(eq(classTags.id, id), eq(classTags.revision, revision))).returning());
        await audit(tx, context, 'tag.deleted', id, tagView(before), null); return { id };
      }));
    },
    async listTemplates(gymId: string, input: ClassTemplateListQuery) {
      const query = classTemplateListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        const filters: SQL[] = [];
        if (query.coachId) filters.push(eq(classTemplates.coachId, query.coachId));
        if (query.programId) filters.push(inArray(classTemplates.id, tx.select({ id: classTemplatePrograms.templateId }).from(classTemplatePrograms).where(eq(classTemplatePrograms.programId, query.programId))));
        if (query.tagId) filters.push(inArray(classTemplates.id, tx.select({ id: classTemplateTags.templateId }).from(classTemplateTags).where(eq(classTemplateTags.tagId, query.tagId))));
        const where = and(...filters);
        const rows = await tx.select().from(classTemplates).where(where).orderBy(asc(classTemplates.weekday), asc(classTemplates.localStartTime), asc(classTemplates.id)).limit(query.limit).offset(query.offset);
        const data = []; for (const row of rows) data.push(await templateView(tx, row));
        return { data, pagination: { limit: query.limit, offset: query.offset, total: await tx.$count(classTemplates, where) } };
      });
    },
    async getTemplate(gymId: string, id: string) {
      return scope(gymId, async (tx) => { const [row] = await tx.select().from(classTemplates).where(eq(classTemplates.id, id)); return templateView(tx, row ?? missing()); });
    },
    async createTemplate(context: MutationContext, input: CreateClassTemplateRequest) {
      const value = createClassTemplateRequestSchema.parse(input), { programIds, tagIds, ...fields } = value;
      const { timezone } = await settings.get(context.gymId);
      return safe(() => scope(context.gymId, async (tx) => {
        await relationships(tx, value);
        const [row] = await tx.insert(classTemplates).values({ ...fields, gymId: context.gymId, createdAt: clock.now() }).returning();
        await mappings(tx, 'template', context.gymId, row!.id, { programIds, tagIds }, clock.now()); const after = await templateView(tx, row!);
        await audit(tx, context, 'template.created', after.id, null, after);
        // Upcoming sessions exist as soon as the template does, not after the nightly job.
        await materializeTemplate(tx, context.gymId, after.id, timezone, clock.now()); return after;
      }));
    },
    async updateTemplate(context: MutationContext, id: string, input: UpdateClassTemplateRequest) {
      const value = updateClassTemplateRequestSchema.parse(input), { revision, programIds, tagIds, ...fields } = value;
      const { timezone } = await settings.get(context.gymId);
      return safe(() => scope(context.gymId, async (tx) => {
        const [row] = await tx.select().from(classTemplates).where(eq(classTemplates.id, id)).for('update'); if (!row) missing();
        const before = await templateView(tx, row); await relationships(tx, value);
        const guard = revisionGuard(classTemplates.revision, revision);
        const afterRow = assertRevised(await tx.update(classTemplates).set({ ...fields, revision: guard.next }).where(and(eq(classTemplates.id, id), guard.matches)).returning());
        await mappings(tx, 'template', context.gymId, id, { programIds, tagIds }, clock.now()); const after = await templateView(tx, afterRow);
        await audit(tx, context, 'template.updated', id, before, after);
        await materializeTemplate(tx, context.gymId, id, timezone, clock.now()); return after;
      }));
    },
    async deleteTemplate(context: MutationContext, id: string, input: ScheduleRevisionRequest) {
      const { revision } = scheduleRevisionRequestSchema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        const [row] = await tx.select().from(classTemplates).where(eq(classTemplates.id, id)).for('update'); if (!row) missing();
        if (row.revision !== revision) throw new RevisionConflictError();
        const before = await templateView(tx, row);
        // Preserve all occurrences, their attendance, and explicit session overrides.
        const sessions = await tx.select().from(classSessions).where(eq(classSessions.templateId, id)).orderBy(asc(classSessions.id)).for('update');
        for (const session of sessions) {
          const guard = revisionGuard(classSessions.revision, session.revision);
          const detached = assertRevised(await tx.update(classSessions).set({ templateId: null, revision: guard.next })
            .where(and(eq(classSessions.id, session.id), guard.matches)).returning());
          await audit(tx, context, 'session.template_removed', session.id, await sessionView(tx, session), await sessionView(tx, detached));
        }
        await tx.delete(classTemplatePrograms).where(eq(classTemplatePrograms.templateId, id));
        await tx.delete(classTemplateTags).where(eq(classTemplateTags.templateId, id));
        assertRevised(await tx.delete(classTemplates).where(and(eq(classTemplates.id, id), eq(classTemplates.revision, revision))).returning());
        await audit(tx, context, 'template.deleted', id, before, null); return { id };
      }));
    },
    async listSessions(gymId: string, input: ClassSessionListQuery) {
      const query = classSessionListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        const filters: SQL[] = [gte(classSessions.startsAt, new Date(query.from)), lt(classSessions.startsAt, new Date(query.until))];
        if (query.coachId) filters.push(eq(classSessions.coachId, query.coachId));
        if (query.status) filters.push(eq(classSessions.status, query.status));
        if (query.programId) filters.push(inArray(classSessions.id, tx.select({ id: classSessionPrograms.sessionId }).from(classSessionPrograms).where(eq(classSessionPrograms.programId, query.programId))));
        if (query.tagId) filters.push(inArray(classSessions.id, tx.select({ id: classSessionTags.sessionId }).from(classSessionTags).where(eq(classSessionTags.tagId, query.tagId))));
        const where = and(...filters);
        const rows = await tx.select().from(classSessions).where(where).orderBy(asc(classSessions.startsAt), asc(classSessions.id)).limit(query.limit).offset(query.offset);
        const data = []; for (const row of rows) data.push(await sessionView(tx, row));
        return { data, pagination: { limit: query.limit, offset: query.offset, total: await tx.$count(classSessions, where) } };
      });
    },
    async getSession(gymId: string, id: string) {
      return scope(gymId, async (tx) => { const [row] = await tx.select().from(classSessions).where(eq(classSessions.id, id)); return sessionView(tx, row ?? missing()); });
    },
    async createSession(context: MutationContext, input: CreateClassSessionRequest) {
      const value = createClassSessionRequestSchema.parse(input), { programIds, tagIds, ...fields } = value;
      return safe(() => scope(context.gymId, async (tx) => {
        await relationships(tx, value);
        const [row] = await tx.insert(classSessions).values({ ...fields, startsAt: new Date(fields.startsAt), endsAt: new Date(fields.endsAt), gymId: context.gymId, createdAt: clock.now() }).returning();
        await mappings(tx, 'session', context.gymId, row!.id, { programIds, tagIds }, clock.now()); const after = await sessionView(tx, row!);
        await audit(tx, context, 'session.created', after.id, null, after); return after;
      }));
    },
    async updateSession(context: MutationContext, id: string, input: UpdateClassSessionRequest) {
      const value = updateClassSessionRequestSchema.parse(input), { revision, programIds, tagIds, ...fields } = value;
      return safe(() => scope(context.gymId, async (tx) => {
        const [row] = await tx.select().from(classSessions).where(eq(classSessions.id, id)).for('update'); if (!row) missing();
        // A generated session keeps its occurrence key when moved, so materialization never recreates it.
        // One generated without a key (by the previous release) was never moved, so its current start is the key.
        const occurrenceStartsAt = row.occurrenceStartsAt ?? (row.templateId ? row.startsAt : null);
        const before = await sessionView(tx, row); await relationships(tx, value);
        const guard = revisionGuard(classSessions.revision, revision);
        const afterRow = assertRevised(await tx.update(classSessions).set({ ...fields, startsAt: new Date(fields.startsAt), endsAt: new Date(fields.endsAt), occurrenceStartsAt, revision: guard.next }).where(and(eq(classSessions.id, id), guard.matches)).returning());
        await reconcileSessionBookings(tx, afterRow, context, clock.now());
        await mappings(tx, 'session', context.gymId, id, { programIds, tagIds }, clock.now()); const after = await sessionView(tx, afterRow);
        await audit(tx, context, 'session.updated', id, before, after); return after;
      }));
    },
    async changeSession(context: MutationContext, id: string, kind: 'cancel' | 'coach' | 'notes' | 'capacity', input: ScheduleRevisionRequest | SwapSessionCoachRequest | UpdateSessionNotesRequest | UpdateSessionCapacityRequest) {
      const schema = kind === 'cancel' ? scheduleRevisionRequestSchema : kind === 'coach' ? swapSessionCoachRequestSchema : kind === 'notes' ? updateSessionNotesRequestSchema : updateSessionCapacityRequestSchema;
      const { revision, ...value } = schema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        // All session mutations share the row lock with attendance and booking changes.
        const [row] = await tx.select().from(classSessions).where(eq(classSessions.id, id)).for('update'); if (!row) missing();
        const before = await sessionView(tx, row);
        if ('coachId' in value && typeof value.coachId === 'string' && !(await tx.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.id, value.coachId))).length) missing();
        const guard = revisionGuard(classSessions.revision, revision);
        const afterRow = assertRevised(await tx.update(classSessions).set({ ...value, ...(kind === 'cancel' ? { status: 'cancelled' } : {}), revision: guard.next }).where(and(eq(classSessions.id, id), guard.matches)).returning());
        if (kind === 'capacity') await reconcileSessionBookings(tx, afterRow, context, clock.now());
        const after = await sessionView(tx, afterRow); await audit(tx, context, 'session.' + kind, id, before, after); return after;
      }));
    },
    async materialize(gymId: string, timezone: string, jobClock: Clock = clock) {
      const now = jobClock.now(); let created = 0;
      const ids = await scope(gymId, (tx) => tx.select({ id: classTemplates.id }).from(classTemplates).orderBy(asc(classTemplates.id)));
      // One template per transaction bounds locks and lets other gyms keep checking in.
      for (const { id } of ids) created += await scope(gymId, (tx) => materializeTemplate(tx, gymId, id, timezone, now));
      return created;
    },
  };
  return service;
}
