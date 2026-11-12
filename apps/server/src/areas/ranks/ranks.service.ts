// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated parameterized batch of attendance criteria under forGym.
import { sql } from 'drizzle-orm';
import {
  forGym, programs, rankSystems, ranks, memberRanks, members, staffProfiles,
  databaseCode, uuidv7, writeAudit, revisionGuard, assertRevised, RevisionConflictError,
} from '@plaingym/db';
import type { Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import {
  programSchema, rankSystemSchema, rankSchema, promotionSchema, paginationSchema,
  createProgramRequestSchema, updateProgramRequestSchema, createRankSystemRequestSchema,
  updateRankSystemRequestSchema, createRankRequestSchema, updateRankRequestSchema,
  createPromotionRequestSchema, bulkPromoteRequestSchema, eligibilityListQuerySchema,
  programListQuerySchema, rankListQuerySchema, promotionListQuerySchema,
  type PaginationInput, type CreatePromotionRequest, type PromotionEligibility,
} from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { notFound, conflict } from '../../core/interfaces/common.js';
import { PromotionCriteria } from './criteria.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import type { AttendanceScope } from '../../core/interfaces/attendance.js';
import type { CriterionContext } from '../../core/interfaces/extensions.js';
import { canReceive, nextPromotion, nextSubRank, promotionOrder } from './progression.js';

type PromotionRow = typeof memberRanks.$inferSelect;
/** The fields of a promotion the rank ordering needs; notes and the promoting coach are never read. */
export type PromotionHistoryEntry = Pick<PromotionRow, 'id' | 'memberId' | 'programId' | 'rankId' | 'subRank' | 'promotedAt' | 'createdAt'>;
const ranked = (row: { promotion: PromotionHistoryEntry; position: number }) => ({
  id: row.promotion.id, memberId: row.promotion.memberId, rankId: row.promotion.rankId, subRank: row.promotion.subRank,
  promotedAt: row.promotion.promotedAt, createdAt: row.promotion.createdAt, position: row.position,
});

const present = <T extends { createdAt: Date }>(row: T) => ({ ...row, createdAt: row.createdAt.toISOString() });
const presentPromotion = (row: typeof memberRanks.$inferSelect) => promotionSchema.parse({
  ...present(row), promotedAt: row.promotedAt.toISOString(),
});
function page<T>(data: T[], input: PaginationInput) {
  // List queries carry filters too; the strict pagination schema takes only its own keys.
  const { limit, offset } = paginationSchema.parse({ limit: input.limit, offset: input.offset });
  return { data: data.slice(offset, offset + limit), pagination: { limit, offset, total: data.length } };
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof RevisionConflictError) conflict('The record changed; reload before saving');
    if (['23503', '23505', '23514'].includes(databaseCode(error) ?? '')) conflict('The change conflicts with existing gym records');
    throw error;
  }
}

export function createRanksService(options: { scope?: typeof forGym; clock: Clock; criteria: PromotionCriteria; settings?: GymSettingsAccessor }) {
  const scope = options.scope ?? forGym, { clock, criteria } = options;
  const settings = options.settings ?? createGymSettingsAccessor({ scope });
  const base = (gymId: string) => { const now = clock.now(); return { gymId, id: uuidv7(now.getTime()), createdAt: now }; };
  async function audit(tx: Transaction, context: MutationContext, action: string, targetId: string, before: unknown, after: unknown) {
    await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
      ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
      action, targetType: action.split('.')[0]!, targetId, before, after, occurredAt: clock.now() });
  }
  async function systemExists(tx: Transaction, id: string) {
    const [row] = await tx.select().from(rankSystems).where(eq(rankSystems.id, id));
    return row ?? notFound();
  }
  async function references(tx: Transaction, programId: string, rankId: string, systemId?: string) {
    // Program, then rank: the same lock order is used by promotion and configuration changes.
    const [program] = await tx.select().from(programs).where(eq(programs.id, programId)).for('share');
    if (!program) notFound();
    const [rank] = await tx.select().from(ranks).where(eq(ranks.id, rankId)).for('share');
    if (!rank) notFound();
    if (!program.rankSystemId || program.rankSystemId !== rank.rankSystemId
      || (systemId && program.rankSystemId !== systemId)) conflict('The program and rank must share a rank system');
    return { program, rank: rankSchema.parse(present(rank)) };
  }
  async function promoteInTransaction(tx: Transaction, context: MutationContext, input: CreatePromotionRequest) {
    // Serializing on the member prevents simultaneous promotions from both passing the history check.
    const [member] = await tx.select().from(members).where(eq(members.id, input.memberId)).for('update');
    if (!member) notFound();
    if (member.anonymizedAt) conflict('An anonymized member cannot be promoted');
    const { program, rank } = await references(tx, input.programId, input.rankId, input.rankSystemId);
    if (!program.active) conflict('The program is inactive');
    if (input.subRank > rank.subRanks.length) conflict('Sub-rank is outside the rank definition');
    if (Date.parse(input.promotedAt) > clock.now().getTime()) conflict('A promotion cannot be in the future');
    // The member row lock above serializes this read; one member's history in one program is small.
    const [previous] = (await tx.select({ promotion: memberRanks, position: ranks.position }).from(memberRanks)
      .innerJoin(ranks, eq(memberRanks.rankId, ranks.id))
      .where(and(eq(memberRanks.memberId, input.memberId), eq(memberRanks.programId, input.programId))))
      .sort((a, b) => promotionOrder(ranked(a), ranked(b)));
    if (previous && (Date.parse(input.promotedAt) < previous.promotion.promotedAt.getTime()
      || rank.position < previous.position
      || (input.rankId === previous.promotion.rankId && input.subRank <= previous.promotion.subRank)))
      conflict('The member has already reached this rank or a later promotion');
    const [staff] = context.actor.kind === 'user'
      ? await tx.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, context.actor.userId)) : [];
    const [row] = await tx.insert(memberRanks).values({ ...base(context.gymId), ...input,
      promotedAt: new Date(input.promotedAt), promotedBy: staff?.id ?? null, notes: input.notes ?? null }).returning();
    const result = presentPromotion(row!);
    // Notes can hold personal details, and audit rows are append-only: record only whether there were any.
    const { notes, ...audited } = result;
    await audit(tx, context, 'promotion.created', row!.id, null, { ...audited, hasNotes: notes !== null });
    return result;
  }
  return {
    /** Batch the dashboard's next-step criteria without paginating or re-reading each member's history. */
    async dashboardEligibility(gymId: string, enabledModules: ReadonlySet<string> = new Set()) {
      const now = clock.now(), gym = await settings.get(gymId);
      const snapshot = await scope(gymId, async tx => {
        const programRows = await tx.select().from(programs).where(and(eq(programs.active, true), isNotNull(programs.rankSystemId)))
          .orderBy(asc(programs.name), asc(programs.id));
        const rankRows = await tx.select().from(ranks).where(inArray(ranks.rankSystemId, programRows.map(program => program.rankSystemId!)))
          .orderBy(asc(ranks.position), asc(ranks.id));
        const roster = await tx.select({ id: members.id, firstName: members.firstName, lastName: members.lastName,
          createdAt: members.createdAt, dateOfBirth: members.dateOfBirth }).from(members)
          .where(and(eq(members.status, 'active'), isNull(members.anonymizedAt)));
        // Match promotionOrder in SQL; only the current step of each active member/program comes back.
        const history = await tx.selectDistinctOn([memberRanks.programId, memberRanks.memberId], { promotion: memberRanks, position: ranks.position }).from(memberRanks)
          .innerJoin(ranks, eq(memberRanks.rankId, ranks.id)).where(and(lte(memberRanks.promotedAt, now),
            inArray(memberRanks.programId, programRows.map(program => program.id)), inArray(memberRanks.memberId, roster.map(member => member.id))))
          .orderBy(asc(memberRanks.programId), asc(memberRanks.memberId), desc(memberRanks.promotedAt), desc(ranks.position),
            desc(memberRanks.subRank), desc(memberRanks.createdAt), desc(memberRanks.id));
        return { programRows, rankRows: rankRows.map(row => rankSchema.parse(present(row))), roster,
          history: history.map(row => ({ ...ranked(row), programId: row.promotion.programId })).sort(promotionOrder) };
      });
      const latest = new Map<string, (typeof snapshot.history)[number]>();
      for (const entry of snapshot.history) {
        const key = entry.programId + ':' + entry.memberId;
        if (!latest.has(key)) latest.set(key, entry);
      }
      const candidates = snapshot.programRows.flatMap(program => {
        const ordered = snapshot.rankRows.filter(rank => rank.rankSystemId === program.rankSystemId);
        return snapshot.roster.flatMap(member => {
          const previous = latest.get(program.id + ':' + member.id), rank = ordered.find(rank => canReceive(previous, rank));
          if (!rank) return [];
          const context: CriterionContext = { attendanceScope: { kind: 'gym', gymId }, gymId, memberId: member.id,
            programId: program.id, rankId: rank.id, promotedAt: (previous?.promotedAt ?? member.createdAt).toISOString(),
            dateOfBirth: member.dateOfBirth, timezone: gym.timezone, clock: { now: () => new Date(now) } };
          return [{ member, rank, context }];
        });
      });
      // Validate every next step, including unavailable module criteria, before reading counts.
      for (const candidate of candidates) criteria.validate(candidate.rank.criteria, enabledModules);
      const counted = candidates.filter(candidate => candidate.rank.criteria.some(item => item.providerId === 'classes-since-promotion'));
      // eslint-disable-next-line database/system-tables -- Reviewed batch counts only this gym's attendance, with bound candidate IDs and dates.
      const counts = counted.length ? await scope(gymId, async tx => tx.execute<{ member_id: string; program_id: string; total: number }>(sql`
        select c.member_id, c.program_id, count(a.id)::integer as total
        from jsonb_to_recordset(${JSON.stringify(counted.map(({ context }) => ({
          member_id: context.memberId, program_id: context.programId, since: context.promotedAt,
        })))}::jsonb) as c(member_id uuid, program_id uuid, since timestamptz)
        left join attendances a on a.gym_id = ${gymId} and a.member_id = c.member_id
          and a.occurred_at >= c.since and a.occurred_at < ${now.toISOString()}::timestamptz
          and (${gym.openMatCountsAsClass} or a.kind = 'class')
          and (a.program_id = c.program_id or exists (
            select 1 from class_session_programs p where p.gym_id = ${gymId}
              and p.session_id = a.session_id and p.program_id = c.program_id
          ))
        group by c.member_id, c.program_id
      `)) : [];
      const totals = new Map(counts.map(row => [row.program_id + ':' + row.member_id, row.total]));
      const batch = new PromotionCriteria();
      for (const provider of criteria.all()) batch.register(provider.id === 'classes-since-promotion' ? {
        ...provider, async evaluate(context, value) {
          const { target } = provider.configSchema.parse(value) as { target: number };
          const current = totals.get(context.programId + ':' + context.memberId) ?? 0;
          return { current, target, met: current >= target };
        },
      } : provider);
      const ready = new Map<string, { memberId: string; firstName: string; lastName: string; programId: string; rankId: string }>();
      for (const { member, rank, context } of candidates) {
        const evaluated = await batch.evaluate(context, rank.criteria, enabledModules);
        if (evaluated.every(item => item.met) && !ready.has(member.id)) ready.set(member.id, {
          memberId: member.id, firstName: member.firstName, lastName: member.lastName, programId: context.programId, rankId: rank.id,
        });
      }
      return [...ready.values()].sort((a, b) => a.lastName.localeCompare(b.lastName)
        || a.firstName.localeCompare(b.firstName) || a.memberId.localeCompare(b.memberId));
    },
    async listPrograms(gymId: string, input: unknown = {}) {
      const query = programListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        if (query.rankSystemId) await systemExists(tx, query.rankSystemId);
        const rows = await tx.select().from(programs).where(and(eq(programs.gymId, gymId),
          query.active === undefined ? undefined : eq(programs.active, query.active),
          query.rankSystemId ? eq(programs.rankSystemId, query.rankSystemId) : undefined)).orderBy(asc(programs.name), asc(programs.id));
        return page(rows.map((row) => programSchema.parse(present(row))), query);
      });
    },
    async listRankSystems(gymId: string, input: PaginationInput = {}) {
      return scope(gymId, async (tx) => page((await tx.select().from(rankSystems)
        .where(eq(rankSystems.gymId, gymId)).orderBy(asc(rankSystems.name), asc(rankSystems.id)))
        .map((row) => rankSystemSchema.parse(present(row))), input));
    },
    async listRanks(gymId: string, input: unknown) {
      const query = rankListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        await systemExists(tx, query.rankSystemId);
        return page((await tx.select().from(ranks).where(eq(ranks.rankSystemId, query.rankSystemId))
          .orderBy(asc(ranks.position), asc(ranks.id))).map((row) => rankSchema.parse(present(row))), query);
      });
    },
    async createProgram(context: MutationContext, input: unknown) {
      const body = createProgramRequestSchema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        if (body.rankSystemId) await systemExists(tx, body.rankSystemId);
        const [row] = await tx.insert(programs).values({ ...base(context.gymId), ...body }).returning();
        const result = programSchema.parse(present(row!));
        await audit(tx, context, 'program.created', result.id, null, result); return result;
      }));
    },
    async updateProgram(context: MutationContext, id: string, input: unknown) {
      const { revision, ...body } = updateProgramRequestSchema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        const [before] = await tx.select().from(programs).where(eq(programs.id, id)).for('update');
        if (!before) notFound();
        if (body.rankSystemId) await systemExists(tx, body.rankSystemId);
        if (body.rankSystemId !== undefined && body.rankSystemId !== before.rankSystemId) {
          const [history] = await tx.select({ id: memberRanks.id }).from(memberRanks).where(eq(memberRanks.programId, id)).limit(1);
          if (history) conflict('A program with promotion history must keep its rank system');
        }
        const guard = revisionGuard(programs.revision, revision);
        const row = assertRevised(await tx.update(programs).set({ ...body, revision: guard.next })
          .where(and(eq(programs.id, id), guard.matches)).returning());
        const result = programSchema.parse(present(row));
        await audit(tx, context, 'program.updated', id, present(before), result); return result;
      }));
    },
    async createRankSystem(context: MutationContext, input: unknown) {
      const body = createRankSystemRequestSchema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        const [row] = await tx.insert(rankSystems).values({ ...base(context.gymId), ...body }).returning();
        const result = rankSystemSchema.parse(present(row!));
        await audit(tx, context, 'rank_system.created', result.id, null, result); return result;
      }));
    },
    async updateRankSystem(context: MutationContext, id: string, input: unknown) {
      const { revision, ...body } = updateRankSystemRequestSchema.parse(input);
      return safe(() => scope(context.gymId, async (tx) => {
        const before = await systemExists(tx, id), guard = revisionGuard(rankSystems.revision, revision);
        const row = assertRevised(await tx.update(rankSystems).set({ ...body, revision: guard.next })
          .where(and(eq(rankSystems.id, id), guard.matches)).returning());
        const result = rankSystemSchema.parse(present(row));
        await audit(tx, context, 'rank_system.updated', id, present(before), result); return result;
      }));
    },
    async createRank(context: MutationContext, input: unknown) {
      const body = createRankRequestSchema.parse(input); criteria.validate(body.criteria);
      return safe(() => scope(context.gymId, async (tx) => {
        await systemExists(tx, body.rankSystemId);
        const [row] = await tx.insert(ranks).values({ ...base(context.gymId), ...body }).returning();
        const result = rankSchema.parse(present(row!));
        await audit(tx, context, 'rank.created', result.id, null, result); return result;
      }));
    },
    async updateRank(context: MutationContext, id: string, input: unknown) {
      const { revision, ...body } = updateRankRequestSchema.parse(input);
      if (body.criteria) criteria.validate(body.criteria);
      return safe(() => scope(context.gymId, async (tx) => {
        const [before] = await tx.select().from(ranks).where(eq(ranks.id, id)).for('update');
        if (!before) notFound();
        if (body.subRanks) {
          const [history] = await tx.select({ id: memberRanks.id }).from(memberRanks)
            .where(and(eq(memberRanks.rankId, id), gt(memberRanks.subRank, body.subRanks.length))).limit(1);
          if (history) conflict('Sub-ranks referenced by promotion history cannot be removed');
        }
        const guard = revisionGuard(ranks.revision, revision);
        const row = assertRevised(await tx.update(ranks).set({ ...body, revision: guard.next })
          .where(and(eq(ranks.id, id), guard.matches)).returning());
        const result = rankSchema.parse(present(row));
        await audit(tx, context, 'rank.updated', id, present(before), result); return result;
      }));
    },
    async listPromotions(gymId: string, input: unknown) {
      const query = promotionListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        const [member] = await tx.select({ id: members.id }).from(members).where(eq(members.id, query.memberId));
        if (!member) notFound();
        if (query.programId) {
          const [program] = await tx.select({ id: programs.id }).from(programs).where(eq(programs.id, query.programId));
          if (!program) notFound();
        }
        return page((await tx.select({ promotion: memberRanks, position: ranks.position }).from(memberRanks).innerJoin(ranks, eq(memberRanks.rankId, ranks.id)).where(and(eq(memberRanks.memberId, query.memberId),
          query.programId ? eq(memberRanks.programId, query.programId) : undefined)))
          .sort((a, b) => promotionOrder(ranked(a), ranked(b))).map(({ promotion }) => presentPromotion(promotion)), query);
      });
    },
    async promote(context: MutationContext, input: unknown) {
      const body = createPromotionRequestSchema.parse(input);
      return safe(() => scope(context.gymId, (tx) => promoteInTransaction(tx, context, body)));
    },
    async bulkPromote(context: MutationContext, input: unknown) {
      const { memberIds, ...body } = bulkPromoteRequestSchema.parse(input);
      // A short transaction per member keeps a large promotion from holding the whole roster.
      // Preflight all references first, so foreign IDs cannot trigger partial writes.
      await scope(context.gymId, async (tx) => {
        await references(tx, body.programId, body.rankId, body.rankSystemId);
        for (const id of memberIds) {
          const [row] = await tx.select({ id: members.id }).from(members).where(eq(members.id, id));
          if (!row) notFound();
        }
      });
      const results = [];
      for (const memberId of memberIds) results.push(await safe(() => scope(context.gymId,
        (tx) => promoteInTransaction(tx, context, { ...body, memberId }))));
      return results;
    },
    async eligibility(gymId: string, input: unknown, enabledModules: ReadonlySet<string> = new Set()) {
      const query = eligibilityListQuerySchema.parse(input), now = clock.now();
      const { timezone } = await settings.get(gymId);
      const snapshot = await scope(gymId, async (tx) => {
        const { program, rank } = await references(tx, query.programId, query.rankId);
        const roster = await tx.select({ id: members.id, createdAt: members.createdAt, dateOfBirth: members.dateOfBirth })
          .from(members).where(and(eq(members.gymId, gymId), isNull(members.anonymizedAt), eq(members.status, 'active')))
          .orderBy(asc(members.id));
        const history = await tx.select({ promotion: memberRanks, position: ranks.position }).from(memberRanks)
          .innerJoin(ranks, eq(memberRanks.rankId, ranks.id))
          .where(and(eq(memberRanks.programId, query.programId), lte(memberRanks.promotedAt, now)));
        return { program, rank, roster, history: history.map(ranked).sort(promotionOrder) };
      });
      // Providers can call other services. Never evaluate them inside the snapshot transaction.
      const results: PromotionEligibility[] = [];
      if (!snapshot.program.active) return page(results, query);
      const latest = new Map<string, (typeof snapshot.history)[number]>();
      for (const entry of snapshot.history) if (!latest.has(entry.memberId)) latest.set(entry.memberId, entry);
      const candidates = snapshot.roster.filter((member) => canReceive(latest.get(member.id), snapshot.rank));
      // An unfiltered page's total is known without evaluating criteria. Ready-only
      // pages must evaluate every candidate before filtering and paginating.
      const selected = query.readyOnly ? candidates : candidates.slice(query.offset, query.offset + query.limit);
      for (const member of selected) {
        const previous = latest.get(member.id);
        const subRank = nextSubRank(previous, snapshot.rank);
        const evaluated = await criteria.evaluate({ attendanceScope: { kind: 'gym', gymId }, gymId, memberId: member.id,
          programId: snapshot.program.id, rankId: snapshot.rank.id,
          promotedAt: (previous?.promotedAt ?? member.createdAt).toISOString(), dateOfBirth: member.dateOfBirth, timezone,
          clock: { now: () => new Date(now) } }, snapshot.rank.criteria, enabledModules);
        const eligible = evaluated.every((item) => item.met);
        if (query.readyOnly && !eligible) continue;
        results.push({ memberId: member.id, rankSystemId: snapshot.rank.rankSystemId,
          program: { id: snapshot.program.id, rankSystemId: snapshot.rank.rankSystemId },
          rank: { id: snapshot.rank.id, rankSystemId: snapshot.rank.rankSystemId }, subRank, eligible, criteria: evaluated });
      }
      return query.readyOnly ? page(results, query)
        : { data: results, pagination: { limit: query.limit, offset: query.offset, total: candidates.length } };
    },
    /**
     * One member's next step in each program they hold a rank in or have attended, using the same ordering and
     * criteria as eligibility. An attended program they hold no rank in is shown only while it is active and its rank
     * system has ranks, after the ranked ones, offering the first rank with its criteria counted from when the member joined.
     * The caller supplies the member, history and attended programs from its own scope (the portal reads them through
     * forHousehold); this reads only those programs and their ranks, and criteria count attendance in the caller's scope.
     */
    async memberProgress<T extends PromotionHistoryEntry>(gymId: string, input: { memberId: string; dateOfBirth: string | null; createdAt: Date;
      history: readonly T[]; attendedProgramIds: readonly string[]; attendanceScope: AttendanceScope },
      enabledModules: ReadonlySet<string> = new Set()) {
      const now = clock.now(), all = input.history.filter((row) => row.memberId === input.memberId);
      const history = all.filter((row) => row.promotedAt <= now), held = new Set(history.map((row) => row.programId));
      const programIds = [...new Set([...held, ...input.attendedProgramIds])];
      if (!all.length && !programIds.length) return { history: [], programs: [], ranks: [], criteria: [] };
      const { timezone } = await settings.get(gymId);
      const snapshot = await scope(gymId, async (tx) => {
        // An attended program without a rank in it is offered only while it is active and has a rank system.
        // Programs with a rank come first, then the others, each in name order.
        const programRows = programIds.length ? (await tx.select().from(programs).where(inArray(programs.id, programIds))
          .orderBy(asc(programs.name), asc(programs.id))).filter((program) => held.has(program.id) || (program.active && program.rankSystemId))
          .sort((a, b) => Number(!held.has(a.id)) - Number(!held.has(b.id))) : [];
        const systemIds = [...new Set(programRows.flatMap((program) => program.rankSystemId ? [program.rankSystemId] : []))];
        // One read covers every shown system's ranks, the first ranks of unranked programs included.
        const rankRows = await tx.select().from(ranks).where(or(inArray(ranks.id, [...new Set(all.map((row) => row.rankId))]),
          systemIds.length ? inArray(ranks.rankSystemId, systemIds) : undefined));
        return { programRows, rankRows: rankRows.map((row) => rankSchema.parse(present(row))) };
      });
      const rankById = new Map(snapshot.rankRows.map((rank) => [rank.id, rank]));
      const order = (row: PromotionHistoryEntry) => ranked({ promotion: row, position: rankById.get(row.rankId)!.position });
      const referenced = new Set<string>(all.map((row) => row.rankId)), result = [], evaluatedCriteria = [];
      for (const program of snapshot.programRows) {
        const own = history.filter((row) => row.programId === program.id);
        const latest = own.length ? own.map(order).sort(promotionOrder)[0]! : undefined;
        const systemRanks = snapshot.rankRows.filter((rank) => rank.rankSystemId === program.rankSystemId);
        // Inactive programs and programs without a rank system offer no promotion, as in eligibility.
        // Without a rank, the first rank comes next, as eligibility offers it to a member with no history.
        const target = !program.active || !program.rankSystemId ? null
          : latest ? nextPromotion(latest, systemRanks)
          : [...systemRanks].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((rank) => ({ rank, subRank: 0 }))[0] ?? null;
        // A program the member holds no rank in, whose system has no ranks yet, has nothing to show.
        if (!latest && !target) continue;
        result.push({ id: program.id, name: program.name, current: latest ? { rankId: latest.rankId, subRank: latest.subRank } : null,
          next: target ? { rankId: target.rank.id, subRank: target.subRank } : null });
        if (!target) continue;
        referenced.add(target.rank.id);
        // Providers can call other services. Never evaluate them inside the snapshot transaction.
        const evaluated = await criteria.evaluate({ attendanceScope: input.attendanceScope, gymId, memberId: input.memberId,
          programId: program.id, rankId: target.rank.id, promotedAt: (latest?.promotedAt ?? input.createdAt).toISOString(),
          dateOfBirth: input.dateOfBirth, timezone, clock: { now: () => new Date(now) } }, target.rank.criteria, enabledModules);
        evaluatedCriteria.push(...evaluated.map((item) => ({ programId: program.id, rankId: target.rank.id, criterionId: item.providerId,
          labelKey: item.labelKey, current: item.current, required: item.target, eligible: item.met })));
      }
      // History in the same order that picks each program's current rank, latest first.
      const ordered = all.map((row) => ({ row, key: order(row) })).sort((a, b) => promotionOrder(a.key, b.key)).map(({ row }) => row);
      return { history: ordered, programs: result, criteria: evaluatedCriteria,
        ranks: snapshot.rankRows.filter((rank) => referenced.has(rank.id)).map(({ id, name, color, subRanks }) => ({ id, name, color, subRanks })) };
    },
  };
}
export type RanksService = ReturnType<typeof createRanksService>;
