// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  forGym, installedPacks, rankSystems, ranks, programs, classTags,
  uuidv7, writeAudit,
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
          // A pack seeds records; after that the gym owns them. Reapplying restores missing
          // records only and never overwrites a name, color, order, or sub-rank the gym edited.
          const systemResults = [], programResults = [];
          for (const system of pack.rankSystems) {
            const systemId = entityId(installation.id, 'system', system.id);
            let [row] = await tx.select().from(rankSystems).where(eq(rankSystems.id, systemId)).for('update');
            if (!row) [row] = await tx.insert(rankSystems).values({ ...base, id: systemId, name: system.name, installedPackId: installation.id }).returning();
            systemResults.push(rankSystemSchema.parse(present(row!)));
            const previous = await tx.select().from(ranks).where(eq(ranks.rankSystemId, systemId)).for('update');
            const taken = new Set(previous.map((item) => item.position));
            let next = Math.max(system.ranks.length - 1, ...previous.map((item) => item.position)) + 1;
            for (const [index, rank] of system.ranks.entries()) {
              const id = entityId(installation.id, 'rank', system.id, rank.id);
              if (previous.some((item) => item.id === id)) continue;
              // A restored rank keeps its pack position unless the gym has used it since.
              const position = taken.has(index) ? next++ : index;
              if (position > 2_147_483_647) throw new AppError('conflict', 'Rank positions are exhausted');
              taken.add(position);
              await tx.insert(ranks).values({ ...base, id, rankSystemId: systemId, name: rank.name, position, color: rank.color ?? null, subRanks: rank.subRanks });
            }
          }
          for (const program of pack.programs) {
            const id = entityId(installation.id, 'program', program.id);
            const rankSystemId = program.rankSystemId ? entityId(installation.id, 'system', program.rankSystemId) : null;
            let [row] = await tx.select().from(programs).where(eq(programs.id, id)).for('update');
            if (!row) [row] = await tx.insert(programs).values({ ...base, id, name: program.name, rankSystemId }).returning();
            programResults.push(programSchema.parse(present(row!)));
          }
          for (const tag of pack.classTags) {
            const id = entityId(installation.id, 'tag', tag.id);
            const [existing] = await tx.select().from(classTags).where(eq(classTags.id, id)).for('update');
            if (!existing) {
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
