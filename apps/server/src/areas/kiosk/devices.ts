// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, eq, isNull, lte, or } from 'drizzle-orm';
import { forGym, kioskDevices, uuidv7, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { kioskDeviceSchema, paginationSchema, registerKioskDeviceRequestSchema, type PaginationInput } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';

const projection = {
  id: kioskDevices.id, name: kioskDevices.name, createdAt: kioskDevices.createdAt,
  revokedAt: kioskDevices.revokedAt, lastSeenAt: kioskDevices.lastSeenAt,
};
const present = (row: { id: string; name: string; createdAt: Date; revokedAt: Date | null; lastSeenAt: Date | null }) =>
  kioskDeviceSchema.parse({ ...row, createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null, lastSeenAt: row.lastSeenAt?.toISOString() ?? null });
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function createKioskDeviceService(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    async list(gymId: string, input: PaginationInput = {}) {
      const { limit, offset } = paginationSchema.parse(input);
      return scope(gymId, async (tx) => {
        const rows = await tx.select(projection).from(kioskDevices).where(eq(kioskDevices.gymId, gymId))
          .orderBy(asc(kioskDevices.id)).limit(limit).offset(offset);
        const [total] = await tx.select({ value: count() }).from(kioskDevices).where(eq(kioskDevices.gymId, gymId));
        return { data: rows.map(present), pagination: { limit, offset, total: total!.value } };
      });
    },
    async register(context: MutationContext, input: unknown) {
      const { name } = registerKioskDeviceRequestSchema.parse(input);
      const token = randomBytes(32).toString('base64url');
      return scope(context.gymId, async (tx) => {
        const now = clock.now();
        const [row] = await tx.insert(kioskDevices).values({
          id: uuidv7(now.getTime()), gymId: context.gymId, name, tokenHash: hash(token), createdAt: now,
        }).returning(projection);
        const device = present(row!);
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'kiosk.device.registered', targetType: 'kiosk_device', targetId: device.id,
          after: device, occurredAt: now });
        return { device, token };
      });
    },
    async revoke(context: MutationContext, id: string) {
      return scope(context.gymId, async (tx) => {
        const predicate = and(eq(kioskDevices.gymId, context.gymId), eq(kioskDevices.id, id));
        const [before] = await tx.select(projection).from(kioskDevices).where(predicate).for('update');
        if (!before) throw new AppError('not_found', 'Device not found');
        if (before.revokedAt) return present(before);
        const now = clock.now();
        const [after] = await tx.update(kioskDevices).set({ revokedAt: now }).where(predicate).returning(projection);
        const device = present(after!);
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'kiosk.device.revoked', targetType: 'kiosk_device', targetId: id,
          before: present(before), after: device, occurredAt: now });
        return device;
      });
    },
    async authenticate(gymId: string, token: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('not_found', 'Device not found');
      return scope(gymId, async (tx) => {
        const now = clock.now();
        const predicate = and(
          eq(kioskDevices.gymId, gymId), eq(kioskDevices.tokenHash, hash(token)), isNull(kioskDevices.revokedAt),
        );
        // Read revocation every time; only stale activity timestamps need a write.
        const [device] = await tx.select({ id: kioskDevices.id, lastSeenAt: kioskDevices.lastSeenAt }).from(kioskDevices).where(predicate);
        if (!device) throw new AppError('not_found', 'Device not found');
        const cutoff = new Date(now.getTime() - 60_000);
        if (!device.lastSeenAt || device.lastSeenAt <= cutoff) await tx.update(kioskDevices).set({ lastSeenAt: now }).where(and(
          predicate, or(isNull(kioskDevices.lastSeenAt), lte(kioskDevices.lastSeenAt, cutoff)),
        ));
        return { kind: 'kiosk' as const, gymId, deviceId: device.id };
      });
    },
  };
}
