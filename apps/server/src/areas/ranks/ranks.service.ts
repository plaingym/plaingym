// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, isNull, lte } from 'drizzle-orm';
import {
  forGym, programs, rankSystems, ranks, memberRanks, members, staffProfiles,
  uuidv7, writeAudit, revisionGuard, assertRevised, RevisionConflictError,
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
import type { PromotionCriteria } from './criteria.js';

const present = <T extends { createdAt: Date }>(row: T) => ({ ...row, createdAt: row.createdAt.toISOString() });
const presentPromotion = (row: typeof memberRanks.$inferSelect) => promotionSchema.parse({
  ...present(row), promotedAt: row.promotedAt.toISOString(),
});
function page<T>(data: T[], input: PaginationInput) {
  // List queries carry filters too; the strict pagination schema takes only its own keys.
  const { limit, offset } = paginationSchema.parse({ limit: input.limit, offset: input.offset });
  return { data: data.slice(offset, offset + limit), pagination: { limit, offset, total: data.length } };
}
function databaseCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return databaseCode(error.cause);
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof RevisionConflictError) conflict('The record changed; reload before saving');
    if (['23503', '23505', '23514'].includes(databaseCode(error) ?? '')) conflict('The change conflicts with existing gym records');
    throw error;
  }
}

export function createRanksService(options: { scope?: typeof forGym; clock: Clock; criteria: PromotionCriteria }) {
  const scope = options.scope ?? forGym, { clock, criteria } = options;
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
    const [previous] = await tx.select({ promotion: memberRanks, position: ranks.position }).from(memberRanks)
      .innerJoin(ranks, eq(memberRanks.rankId, ranks.id))
      .where(and(eq(memberRanks.memberId, input.memberId), eq(memberRanks.programId, input.programId)))
      .orderBy(desc(memberRanks.promotedAt), desc(ranks.position), desc(memberRanks.subRank), desc(memberRanks.createdAt), desc(memberRanks.id)).limit(1);
    if (previous && (Date.parse(input.promotedAt) < previous.promotion.promotedAt.getTime()
      || rank.position < previous.position
      || (input.rankId === previous.promotion.rankId && input.subRank <= previous.promotion.subRank)))
      conflict('The member has already reached this rank or a later promotion');
    const [staff] = context.actor.kind === 'user'
      ? await tx.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, context.actor.userId)) : [];
    const [row] = await tx.insert(memberRanks).values({ ...base(context.gymId), ...input,
      promotedAt: new Date(input.promotedAt), promotedBy: staff?.id ?? null, notes: input.notes ?? null }).returning();
    const result = presentPromotion(row!);
    await audit(tx, context, 'promotion.created', row!.id, null, result);
    return result;
  }
  return {
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
        return page((await tx.select({ promotion: memberRanks }).from(memberRanks).innerJoin(ranks, eq(memberRanks.rankId, ranks.id)).where(and(eq(memberRanks.memberId, query.memberId),
          query.programId ? eq(memberRanks.programId, query.programId) : undefined))
          .orderBy(desc(memberRanks.promotedAt), desc(ranks.position), desc(memberRanks.subRank), desc(memberRanks.createdAt), desc(memberRanks.id)))
          .map(({ promotion }) => presentPromotion(promotion)), query);
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
      const snapshot = await scope(gymId, async (tx) => {
        const { program, rank } = await references(tx, query.programId, query.rankId);
        const roster = await tx.select({ id: members.id, createdAt: members.createdAt, dateOfBirth: members.dateOfBirth })
          .from(members).where(and(eq(members.gymId, gymId), isNull(members.anonymizedAt), eq(members.status, 'active')))
          .orderBy(asc(members.id));
        const history = await tx.select({ promotion: memberRanks, position: ranks.position }).from(memberRanks)
          .innerJoin(ranks, eq(memberRanks.rankId, ranks.id))
          .where(and(eq(memberRanks.programId, query.programId), lte(memberRanks.promotedAt, now)))
          .orderBy(desc(memberRanks.promotedAt), desc(ranks.position), desc(memberRanks.subRank), desc(memberRanks.createdAt), desc(memberRanks.id));
        return { program, rank, roster, history };
      });
      // Providers can call other services. Never evaluate them inside the snapshot transaction.
      const results: PromotionEligibility[] = [];
      if (!snapshot.program.active) return page(results, query);
      const latest = new Map<string, (typeof snapshot.history)[number]>();
      for (const entry of snapshot.history) if (!latest.has(entry.promotion.memberId)) latest.set(entry.promotion.memberId, entry);
      for (const member of snapshot.roster) {
        const previous = latest.get(member.id);
        if (previous && (previous.position > snapshot.rank.position
          || (previous.promotion.rankId === snapshot.rank.id && previous.promotion.subRank >= snapshot.rank.subRanks.length))) continue;
        const subRank = previous?.promotion.rankId === snapshot.rank.id ? previous.promotion.subRank + 1 : 0;
        const evaluated = await criteria.evaluate({ attendanceScope: { kind: 'gym', gymId }, gymId, memberId: member.id,
          programId: snapshot.program.id, rankId: snapshot.rank.id,
          promotedAt: (previous?.promotion.promotedAt ?? member.createdAt).toISOString(), dateOfBirth: member.dateOfBirth,
          clock: { now: () => new Date(now) } }, snapshot.rank.criteria, enabledModules);
        const eligible = evaluated.every((item) => item.met);
        if (query.readyOnly && !eligible) continue;
        results.push({ memberId: member.id, rankSystemId: snapshot.rank.rankSystemId,
          program: { id: snapshot.program.id, rankSystemId: snapshot.rank.rankSystemId },
          rank: { id: snapshot.rank.id, rankSystemId: snapshot.rank.rankSystemId }, subRank, eligible, criteria: evaluated });
      }
      return page(results, query);
    },
  };
}
