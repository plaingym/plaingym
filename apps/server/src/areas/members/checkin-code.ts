// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { assertRevised, forGym, members, revisionGuard, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { portalRegenerateCheckinRequestSchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { GymKeyResolver } from '../settings/gym-keys.js';

export const checkinCodePattern = /^pgci1_[A-Za-z0-9_-]{43}$/;
export function deriveCheckinCode(key: Uint8Array, gymId: string, memberId: string, version: number): string {
  if (key.byteLength < 32 || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid check-in code configuration');
  return 'pgci1_' + createHmac('sha256', key).update(JSON.stringify(['member-checkin-v1', gymId.toLowerCase(), memberId.toLowerCase(), version])).digest('base64url');
}
export const hashCheckinCode = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex');
function matches(left: string, right: string) {
  return timingSafeEqual(Buffer.from(hashCheckinCode(left), 'hex'), Buffer.from(hashCheckinCode(right), 'hex'));
}
export interface CheckinCodeOptions { scope?: typeof forGym; clock?: Clock; gymKey?: GymKeyResolver }
export function createCheckinCodeService(options: CheckinCodeOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const fields = { memberId: members.id, version: members.checkinCodeVersion, hash: members.checkinCodeHash, revision: members.revision };
  async function key(gymId: string) {
    if (!options.gymKey) throw new AppError('unavailable', 'Check-in codes are not configured');
    return options.gymKey(gymId);
  }
  async function change(context: MutationContext, memberId: string, input: unknown, revoke: boolean) {
    const { revision } = portalRegenerateCheckinRequestSchema.parse(input);
    const gymKey = revoke ? undefined : await key(context.gymId);
    return scope(context.gymId, async (tx) => {
      const [row] = await tx.select(fields).from(members).where(and(eq(members.id, memberId), isNull(members.anonymizedAt))).for('update');
      if (!row) throw new AppError('not_found', 'Resource not found');
      if (row.version === 2_147_483_647) throw new AppError('conflict', 'Check-in code version exhausted');
      const version = row.version + 1, code = revoke ? null : deriveCheckinCode(gymKey!, context.gymId, memberId, version);
      const guard = revisionGuard(members.revision, revision);
      const saved = assertRevised(await tx.update(members).set({ checkinCodeVersion: version,
        checkinCodeHash: code ? hashCheckinCode(code) : null, revision: guard.next })
        .where(and(eq(members.id, memberId), guard.matches, isNull(members.anonymizedAt))).returning(fields));
      await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
        ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
        action: revoke ? 'member.checkin_code.revoked' : 'member.checkin_code.regenerated', targetType: 'member', targetId: memberId,
        before: { version: row.version }, after: { version }, occurredAt: clock.now(), createdAt: clock.now() });
      return { memberId, version, revision: saved.revision, code };
    });
  }
  return {
    /** A read never silently reactivates a revoked code. */
    async read(gymId: string, memberId: string) {
      const [row] = await scope(gymId, (tx) => tx.select(fields).from(members).where(and(eq(members.id, memberId), isNull(members.anonymizedAt))));
      if (!row) throw new AppError('not_found', 'Resource not found');
      const code = row.hash ? deriveCheckinCode(await key(gymId), gymId, memberId, row.version) : null;
      if (code && hashCheckinCode(code) !== row.hash) throw new AppError('unavailable', 'Check-in code is unavailable');
      return { memberId, version: row.version, revision: row.revision, code };
    },
    regenerate: (context: MutationContext, memberId: string, input: unknown) => change(context, memberId, input, false),
    revoke: (context: MutationContext, memberId: string, input: unknown) => change(context, memberId, input, true),
    /** A QR is authority for this member only; no household roster or member IDs are accepted from it. */
    async resolve(gymId: string, code: string): Promise<string | null> {
      if (!checkinCodePattern.test(code)) return null;
      const [row] = await scope(gymId, (tx) => tx.select(fields).from(members)
        .where(and(eq(members.checkinCodeHash, hashCheckinCode(code)), isNull(members.anonymizedAt))));
      if (!row) return null;
      return matches(deriveCheckinCode(await key(gymId), gymId, row.memberId, row.version), code) ? row.memberId : null;
    },
  };
}
export type CheckinCodeService = ReturnType<typeof createCheckinCodeService>;
