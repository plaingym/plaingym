// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  forGym, installedPacks, rankSystems, ranks, programs, classTags,
  uuidv7, writeAudit, revisionGuard, assertRevised,
} from '@plaingym/db';
import { AppError, contentPackSchema, type Clock } from '@plaingym/shared';
import {
  installedPackSchema, rankSystemSchema, programSchema, paginationSchema,
  type PaginationInput,
} from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';

/** Keep the installation's UUIDv7 timestamp; derive its entity bits from stable pack IDs.
 * This lets names and positions change without a separate mapping table or name-based identity.
 */
function entityId(installation: string, ...path: string[]): string {
  const bytes = createHash('sha256').update(JSON.stringify([installation, ...path])).digest().subarray(0, 16);
  Buffer.from(installation.replaceAll('-', ''), 'hex').copy(bytes, 0, 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const present = <T extends { createdAt: Date }>(row: T) => ({ ...row, createdAt: row.createdAt.toISOString() });
function databaseCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return databaseCode(error.cause);
}

export function createContentPackService(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    async list(gymId: string, input: PaginationInput = {}) {
      const { limit, offset } = paginationSchema.parse(input);
      return scope(gymId, async (tx) => {
        const rows = await tx.select().from(installedPacks).where(eq(installedPacks.gymId, gymId))
          .orderBy(asc(installedPacks.id)).limit(limit).offset(offset);
        const [total] = await tx.select({ value: count() }).from(installedPacks).where(eq(installedPacks.gymId, gymId));
        return { data: rows.map((row) => installedPackSchema.parse(present(row))),
          pagination: { limit, offset, total: total!.value } };
      });
    },
    async apply(context: MutationContext, input: unknown) {
      const pack = contentPackSchema.parse(input);
      for (const items of [pack.programs, pack.classTags]) {
        if (new Set(items.map((item) => item.name)).size !== items.length)
          throw new AppError('invalid_request', 'Program and class tag names must be unique within a pack');
      }
      try {
        return await scope(context.gymId, async (tx) => {
          const now = clock.now(), gymId = context.gymId;
          const base = { gymId, createdAt: now };
          await tx.insert(installedPacks).values({ ...base, id: uuidv7(now.getTime()), packId: pack.id, version: pack.version })
            .onConflictDoNothing({ target: [installedPacks.gymId, installedPacks.packId, installedPacks.version] });
          // The unique insertion and row lock serialize concurrent first installs and reapplications.
          const [installation] = await tx.select().from(installedPacks).where(and(
            eq(installedPacks.gymId, gymId), eq(installedPacks.packId, pack.id), eq(installedPacks.version, pack.version),
          )).for('update');
          if (!installation) throw new AppError('not_found', 'Content pack installation not found');
          const systemResults = [], programResults = [];
          for (const system of pack.rankSystems) {
            const systemId = entityId(installation.id, 'system', system.id);
            const [existing] = await tx.select().from(rankSystems).where(eq(rankSystems.id, systemId)).for('update');
            let row = existing;
            if (!row) [row] = await tx.insert(rankSystems).values({ ...base, id: systemId, name: system.name, installedPackId: installation.id }).returning();
            else if (row.name !== system.name) {
              const guard = revisionGuard(rankSystems.revision, row.revision);
              row = assertRevised(await tx.update(rankSystems).set({ name: system.name, revision: guard.next })
                .where(and(eq(rankSystems.id, systemId), guard.matches)).returning());
            }
            systemResults.push(rankSystemSchema.parse(present(row!)));
            const previous = await tx.select().from(ranks).where(eq(ranks.rankSystemId, systemId)).for('update');
            const moving = previous.filter((row) => system.ranks.some((rank, position) =>
              entityId(installation.id, 'rank', system.id, rank.id) === row.id && row.position !== position));
            // Move changed positions out of the way before assigning their final unique positions.
            let temporary = Math.max(system.ranks.length, ...previous.map((row) => row.position)) + 1;
            for (const row of moving) {
              if (temporary > 2_147_483_647) throw new AppError('conflict', 'Rank positions cannot be reordered');
              const guard = revisionGuard(ranks.revision, row.revision);
              const moved = assertRevised(await tx.update(ranks).set({ position: temporary++, revision: guard.next })
                .where(and(eq(ranks.id, row.id), guard.matches)).returning());
              Object.assign(row, moved);
            }
            for (const [position, rank] of system.ranks.entries()) {
              const id = entityId(installation.id, 'rank', system.id, rank.id);
              const row = previous.find((item) => item.id === id);
              const color = rank.color ?? null;
              if (!row) await tx.insert(ranks).values({ ...base, id, rankSystemId: systemId, name: rank.name, position, color, subRanks: rank.subRanks });
              else if (row.name !== rank.name || row.position !== position || row.color !== color || JSON.stringify(row.subRanks) !== JSON.stringify(rank.subRanks)) {
                const guard = revisionGuard(ranks.revision, row.revision);
                assertRevised(await tx.update(ranks).set({ name: rank.name, position, color, subRanks: rank.subRanks, revision: guard.next })
                  .where(and(eq(ranks.id, id), guard.matches)).returning());
              }
            }
          }
          for (const program of pack.programs) {
            const id = entityId(installation.id, 'program', program.id);
            const rankSystemId = program.rankSystemId ? entityId(installation.id, 'system', program.rankSystemId) : null;
            const [existing] = await tx.select().from(programs).where(eq(programs.id, id)).for('update');
            let row = existing;
            if (!row) [row] = await tx.insert(programs).values({ ...base, id, name: program.name, rankSystemId }).returning();
            else if (row.name !== program.name || row.rankSystemId !== rankSystemId) {
              const guard = revisionGuard(programs.revision, row.revision);
              row = assertRevised(await tx.update(programs).set({ name: program.name, rankSystemId, revision: guard.next })
                .where(and(eq(programs.id, id), guard.matches)).returning());
            }
            programResults.push(programSchema.parse(present(row!)));
          }
          for (const tag of pack.classTags) {
            const id = entityId(installation.id, 'tag', tag.id);
            const [existing] = await tx.select().from(classTags).where(eq(classTags.id, id)).for('update');
            if (existing && existing.name !== tag.name) {
              const guard = revisionGuard(classTags.revision, existing.revision);
              assertRevised(await tx.update(classTags).set({ name: tag.name, revision: guard.next })
                .where(and(eq(classTags.id, id), guard.matches)).returning());
            } else if (!existing) {
              // Class tags are shared vocabulary: reuse an existing tag of the same name.
              await tx.insert(classTags).values({ ...base, id, name: tag.name })
                .onConflictDoNothing({ target: [classTags.gymId, classTags.name] });
            }
          }
          await writeAudit(tx, { ...base, actorKind: context.actor.kind,
            ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
            action: 'content_pack.applied', targetType: 'installed_pack', targetId: installation.id,
            after: { pack }, occurredAt: now });
          return { installedPack: installedPackSchema.parse(present(installation)), rankSystems: systemResults, programs: programResults };
        });
      } catch (error) {
        if (['23505', '23503'].includes(databaseCode(error) ?? ''))
          throw new AppError('conflict', 'Content pack conflicts with existing gym records');
        throw error;
      }
    },
  };
}
