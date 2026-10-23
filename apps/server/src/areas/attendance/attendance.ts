// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import {
  attendances, classSessions, classSessionPrograms, classSessionTags, classTags,
  forGym, forHousehold, members, programs, uuidv7, writeAudit, type Transaction,
} from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import {
  attendanceListQuerySchema, attendanceSchema, attendanceSourceSchema, attendanceTotalsQuerySchema, classKindSchema,
  idSchema, instantSchema, paginationSchema, recordAttendanceRequestSchema,
  type Attendance, type AttendanceListQuery, type AttendanceSource, type AttendanceTotals, type ClassKind,
  type AttendanceTotalsQuery, type Pagination, type RecordAttendanceRequest,
} from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { AttendanceFilter, AttendanceQueries, AttendanceScope } from '../../core/interfaces/attendance.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { createGymSettingsAccessor } from '../settings/settings.js';

type Row = typeof attendances.$inferSelect;
type Filter = { readonly [K in keyof AttendanceFilter]?: AttendanceFilter[K] | undefined }
  & { sessionId?: string | undefined; source?: AttendanceSource | undefined; kind?: ClassKind | undefined;
    /** Resolved from `classesOnly` and the gym's open-mat setting. */
    excludeOpenMat?: boolean | undefined };
export interface AttendanceMutation {
  readonly gymId: string;
  readonly actor: { kind: 'user'; userId: string } | { kind: 'system' } | { kind: 'device'; deviceId: string };
}
/** Trusted callers assign the source; coach HTTP requests cannot impersonate a kiosk or import.
 * Only imports without a session may set the kind; it defaults to a class. */
export interface AttendanceOrigin { source: AttendanceSource; sourceKey?: string; kind?: ClassKind; }
export interface AttendanceOptions {
  scope?: typeof forGym; householdScope?: typeof forHousehold; clock?: Clock; settings?: GymSettingsAccessor;
}
function missing(): never { throw new AppError('not_found', 'Resource not found'); }
const present = (row: Row): Attendance => attendanceSchema.parse({
  id: row.id, memberId: row.memberId, sessionId: row.sessionId, programId: row.programId,
  occurredAt: row.occurredAt.toISOString(), source: row.source, kind: row.kind, createdAt: row.createdAt.toISOString(),
});

function validateFilter(filter: Filter) {
  for (const id of [filter.memberId, filter.programId, filter.tagId, filter.sessionId])
    if (id !== undefined) idSchema.parse(id);
  if (filter.source !== undefined) attendanceSourceSchema.parse(filter.source);
  if (filter.kind !== undefined) classKindSchema.parse(filter.kind);
  if (filter.since !== undefined) instantSchema.parse(filter.since);
  if (filter.until !== undefined) instantSchema.parse(filter.until);
  if (filter.since && filter.until && Date.parse(filter.until) < Date.parse(filter.since))
    throw new AppError('invalid_request', 'Attendance range ends before it starts');
}
function predicate(tx: Transaction, gymId: string, filter: Filter) {
  return and(eq(attendances.gymId, gymId),
    filter.memberId ? eq(attendances.memberId, filter.memberId) : undefined,
    filter.sessionId ? eq(attendances.sessionId, filter.sessionId) : undefined,
    filter.source ? eq(attendances.source, filter.source) : undefined,
    filter.kind ? eq(attendances.kind, filter.kind) : undefined,
    filter.excludeOpenMat ? eq(attendances.kind, 'class') : undefined,
    filter.since ? gte(attendances.occurredAt, new Date(filter.since)) : undefined,
    filter.until ? lt(attendances.occurredAt, new Date(filter.until)) : undefined,
    filter.programId ? or(eq(attendances.programId, filter.programId), inArray(attendances.sessionId,
      tx.select({ id: classSessionPrograms.sessionId }).from(classSessionPrograms).where(and(
        eq(classSessionPrograms.gymId, gymId), eq(classSessionPrograms.programId, filter.programId),
      )))) : undefined,
    filter.tagId ? inArray(attendances.sessionId,
      tx.select({ id: classSessionTags.sessionId }).from(classSessionTags).where(and(
        eq(classSessionTags.gymId, gymId), eq(classSessionTags.tagId, filter.tagId),
      ))) : undefined,
  );
}
async function requireReferences(tx: Transaction, gymId: string, filter: Filter) {
  if (filter.memberId && !(await tx.select({ id: members.id }).from(members)
    .where(and(eq(members.gymId, gymId), eq(members.id, filter.memberId))))[0]) missing();
  if (filter.sessionId && !(await tx.select({ id: classSessions.id }).from(classSessions)
    .where(and(eq(classSessions.gymId, gymId), eq(classSessions.id, filter.sessionId))))[0]) missing();
  if (filter.programId && !(await tx.select({ id: programs.id }).from(programs)
    .where(and(eq(programs.gymId, gymId), eq(programs.id, filter.programId))))[0]) missing();
  if (filter.tagId && !(await tx.select({ id: classTags.id }).from(classTags)
    .where(and(eq(classTags.gymId, gymId), eq(classTags.id, filter.tagId))))[0]) missing();
}
/** Only session metadata is read here, never household or attendance rows. */
async function sessionLinks(tx: Transaction, gymId: string, rows: readonly Row[]) {
  const ids = [...new Set(rows.flatMap((row) => row.sessionId ? [row.sessionId] : []))];
  const programLinks = ids.length ? await tx.select().from(classSessionPrograms)
    .where(and(eq(classSessionPrograms.gymId, gymId), inArray(classSessionPrograms.sessionId, ids))) : [];
  const tagLinks = ids.length ? await tx.select().from(classSessionTags)
    .where(and(eq(classSessionTags.gymId, gymId), inArray(classSessionTags.sessionId, ids))) : [];
  const bySession = new Map<string, { programs: Set<string>; tags: Set<string> }>();
  for (const id of ids) bySession.set(id, { programs: new Set(), tags: new Set() });
  for (const link of programLinks) bySession.get(link.sessionId)!.programs.add(link.programId);
  for (const link of tagLinks) bySession.get(link.sessionId)!.tags.add(link.tagId);
  return bySession;
}

export function createAttendanceService(options: AttendanceOptions = {}) {
  const scope = options.scope ?? forGym, householdScope = options.householdScope ?? forHousehold;
  const clock = options.clock ?? defaultClock, settings = options.settings ?? createGymSettingsAccessor({ scope });
  async function countsOpenMat(gymId: string) { return (await settings.get(gymId)).openMatCountsAsClass; }
  async function resolve(gymId: string, filter: Filter): Promise<Filter> {
    return filter.classesOnly ? { ...filter, excludeOpenMat: !(await countsOpenMat(gymId)) } : filter;
  }
  async function listInGym(gymId: string, filter: Filter, page: Pagination, requireResources: boolean) {
    validateFilter(filter);
    const { limit, offset } = paginationSchema.parse({ limit: page.limit, offset: page.offset });
    return scope(gymId, async (tx) => {
      if (requireResources) await requireReferences(tx, gymId, filter);
      const where = predicate(tx, gymId, filter);
      const rows = await tx.select().from(attendances).where(where)
        .orderBy(desc(attendances.occurredAt), asc(attendances.id)).limit(limit).offset(offset);
      const [total] = await tx.select({ value: count() }).from(attendances).where(where);
      return { data: rows.map(present), pagination: { limit, offset, total: total!.value } };
    });
  }
  async function householdRows(identity: Extract<AttendanceScope, { kind: 'household' }>['identity'], filter: Filter) {
    validateFilter(filter);
    // Reload the grant on every call. Only this scoped API may read household activity.
    const rows = await householdScope({ kind: 'user', ...identity }, async (queries) => {
      if (filter.memberId && !(await queries.member(filter.memberId))[0]) missing();
      return queries.attendance();
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'Household access denied') missing();
      throw error;
    });
    // Enrich only the sessions referenced by the already-authorized rows. Do not read
    // activity with a gym grant, even when no member filter was supplied.
    const links = filter.programId || filter.tagId
      ? await scope(identity.gymId, (tx) => sessionLinks(tx, identity.gymId, rows)) : new Map();
    return rows.filter((row) => (!filter.memberId || row.memberId === filter.memberId)
      && (!filter.since || row.occurredAt.getTime() >= Date.parse(filter.since))
      && (!filter.until || row.occurredAt.getTime() < Date.parse(filter.until))
      && (!filter.kind || row.kind === filter.kind) && (!filter.excludeOpenMat || row.kind === 'class')
      && (!filter.programId || row.programId === filter.programId
        || (row.sessionId !== null && links.get(row.sessionId)?.programs.has(filter.programId)))
      && (!filter.tagId || (row.sessionId !== null && links.get(row.sessionId)?.tags.has(filter.tagId))))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id));
  }
  const queries: AttendanceQueries = {
    async countSince(context, input) {
      const filter = await resolve(context.kind === 'gym' ? context.gymId : context.identity.gymId, input);
      if (context.kind === 'household') return (await householdRows(context.identity, filter)).length;
      validateFilter(filter);
      return scope(context.gymId, async (tx) => {
        const [total] = await tx.select({ value: count() }).from(attendances).where(predicate(tx, context.gymId, filter));
        return total!.value;
      });
    },
    async history(context, input, page) {
      const filter = await resolve(context.kind === 'gym' ? context.gymId : context.identity.gymId, input);
      if (context.kind === 'gym') {
        const result = await listInGym(context.gymId, filter, page, false);
        return { ...result, data: result.data.map(({ id, memberId, sessionId, programId, occurredAt, source, kind }) => ({
          id, memberId, sessionId, programId, occurredAt, source, kind,
        })) };
      }
      const { limit, offset } = paginationSchema.parse({ limit: page.limit, offset: page.offset });
      const rows = await householdRows(context.identity, filter);
      return { data: rows.slice(offset, offset + limit).map(({ id, memberId, sessionId, programId, occurredAt, source, kind }) => ({
        id, memberId, sessionId, programId, occurredAt: occurredAt.toISOString(), source: attendanceSourceSchema.parse(source),
        kind: classKindSchema.parse(kind),
      })), pagination: { limit, offset, total: rows.length } };
    },
  };
  return {
    queries,
    async record(context: AttendanceMutation, input: RecordAttendanceRequest, origin: AttendanceOrigin = { source: 'coach' }) {
      const value = recordAttendanceRequestSchema.parse(input);
      attendanceSourceSchema.parse(origin.source);
      if (origin.sourceKey !== undefined && (origin.source !== 'import' || !origin.sourceKey.trim()))
        throw new AppError('invalid_request', 'Only imports accept a nonempty source key');
      if (origin.kind !== undefined && (origin.source !== 'import' || value.sessionId))
        throw new AppError('invalid_request', 'Only imports without a session accept a kind');
      if (origin.kind !== undefined) classKindSchema.parse(origin.kind);
      // The session decides the kind; a live visit without a session is open mat.
      let kind: ClassKind = origin.kind ?? (origin.source === 'import' ? 'class' : 'open_mat');
      return scope(context.gymId, async (tx) => {
        const gymId = context.gymId, now = clock.now();
        await requireReferences(tx, gymId, { memberId: value.memberId,
          ...(value.programId ? { programId: value.programId } : {}) });
        if (value.sessionId) {
          // Serialize with cancellation/deletion. Uniqueness, not elapsed time, deduplicates check-ins.
          const [session] = await tx.select().from(classSessions).where(and(
            eq(classSessions.gymId, gymId), eq(classSessions.id, value.sessionId),
          )).for('update');
          if (!session) missing();
          const [existing] = await tx.select().from(attendances).where(and(
            eq(attendances.gymId, gymId), eq(attendances.memberId, value.memberId), eq(attendances.sessionId, value.sessionId),
          ));
          if (existing) return present(existing);
          if (session.status === 'cancelled') throw new AppError('conflict', 'Session is cancelled');
          kind = classKindSchema.parse(session.kind);
        }
        const [inserted] = await tx.insert(attendances).values({
          id: uuidv7(now.getTime()), gymId, memberId: value.memberId, sessionId: value.sessionId,
          programId: value.programId, occurredAt: value.occurredAt ? new Date(value.occurredAt) : now,
          source: origin.source, sourceKey: origin.sourceKey ?? null, kind, createdAt: now,
        }).onConflictDoNothing().returning();
        if (!inserted) {
          if (!value.sessionId && !origin.sourceKey) throw new AppError('conflict', 'Attendance already exists');
          const [existing] = await tx.select().from(attendances).where(and(eq(attendances.gymId, gymId), or(
            value.sessionId ? and(eq(attendances.sessionId, value.sessionId), eq(attendances.memberId, value.memberId)) : undefined,
            origin.sourceKey ? eq(attendances.sourceKey, origin.sourceKey) : undefined,
          )));
          if (!existing || existing.memberId !== value.memberId || existing.sessionId !== value.sessionId)
            throw new AppError('conflict', 'Attendance source key already used');
          return present(existing);
        }
        const data = present(inserted);
        await writeAudit(tx, { gymId, createdAt: now, occurredAt: now, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          ...(context.actor.kind === 'device' ? { actorDeviceId: context.actor.deviceId } : {}),
          action: 'attendance.recorded', targetType: 'attendance', targetId: inserted.id, after: data });
        return data;
      });
    },
    list(gymId: string, input: AttendanceListQuery) {
      const value = attendanceListQuerySchema.parse(input);
      return listInGym(gymId, value, value, true);
    },
    async totals(gymId: string, input: AttendanceTotalsQuery): Promise<AttendanceTotals> {
      const filter = attendanceTotalsQuerySchema.parse(input), openMatIsClass = await countsOpenMat(gymId);
      return scope(gymId, async (tx) => {
        await requireReferences(tx, gymId, filter);
        const rows = await tx.select().from(attendances).where(predicate(tx, gymId, filter));
        const links = await sessionLinks(tx, gymId, rows);
        const byProgram = new Map<string, number>(), byTag = new Map<string, number>();
        for (const row of rows) {
          const session = row.sessionId ? links.get(row.sessionId) : undefined;
          const programIds = new Set(session?.programs);
          if (row.programId) programIds.add(row.programId);
          for (const id of programIds) byProgram.set(id, (byProgram.get(id) ?? 0) + 1);
          for (const id of session?.tags ?? []) byTag.set(id, (byTag.get(id) ?? 0) + 1);
        }
        const openMat = rows.filter((row) => row.kind === 'open_mat').length;
        return { memberId: filter.memberId, total: rows.length, classes: openMatIsClass ? rows.length : rows.length - openMat, openMat,
          byProgram: [...byProgram].sort(([a], [b]) => a.localeCompare(b)).map(([programId, count]) => ({ programId, count })),
          byTag: [...byTag].sort(([a], [b]) => a.localeCompare(b)).map(([tagId, count]) => ({ tagId, count })) };
      });
    },
  };
}
export function createAttendanceQueries(options: AttendanceOptions = {}): AttendanceQueries {
  return createAttendanceService(options).queries;
}
