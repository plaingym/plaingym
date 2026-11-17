// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, inArray, or } from 'drizzle-orm';
import { forGym, forSystem, gyms, gymDomains, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { demoCopyRequest, idSchema, type DemoRole } from '@plaingym/shared/contracts';
import type { DemoService } from './service.js';
import { logError } from '../core/log.js';
import { requireDemo, sandboxSettings, type DemoConfig, type SandboxSettings, type SeedRecovery } from './config.js';
import { demoText } from './queries.js';

const day = 86_400_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type Gym = typeof gyms.$inferSelect;
const settingsOf = (gym: Gym) => gym.settings as Record<string, unknown>;
const queueOrder = (gym: Gym) => sandboxSettings(gym.settings)?.ticketOrder ?? `${gym.createdAt.toISOString()}:${gym.id}`;
/** Reservations, ready claims and bearer consumption commit under row locks. No seed holds a transaction. */
export function createDemoPool(options: {
  config: DemoConfig; service: DemoService; key: Buffer; clock: Clock;
  scope?: typeof forGym; system?: typeof forSystem;
}) {
  const scope = options.scope ?? forGym, system = options.system ?? forSystem;
  const showcaseHostname = `showcase.${options.config.domain}`;
  let wake: () => Promise<void> = async () => {};
  let checkpoint: (recovery: SeedRecovery) => Promise<void> = async () => {};
  let recoveryFor: (ticketHash: string) => Promise<SeedRecovery | undefined> = async () => undefined;
  const all = () => system(tx => tx.select().from(gyms).orderBy(asc(gyms.createdAt), asc(gyms.id)));
  const copyToken = (ticket: string) => createHmac('sha256', options.key).update('demo-copy-v1:' + ticket).digest('base64url');
  const idleExpiry = (now: Date) => new Date(now.getTime() + (options.config.idleHours ?? 2) * 3_600_000).toISOString();
  async function update(gymId: string, change: (demo: SandboxSettings, gym: Gym) => SandboxSettings, action = 'demo.lifecycle_updated') {
    return scope(gymId, async tx => {
      const [gym] = await tx.select().from(gyms).where(eq(gyms.id, gymId)).for('update');
      const demo = sandboxSettings(gym?.settings);
      if (!gym || !demo) throw new AppError('not_found', 'Not found');
      const next = change(demo, gym);
      if (next === demo) return demo;
      await tx.update(gyms).set({ settings: { ...settingsOf(gym), demo: next }, revision: gym.revision + 1, updatedAt: options.clock.now() }).where(eq(gyms.id, gymId));
      await writeAudit(tx, { gymId, actorKind: 'system', action, targetType: 'gym', targetId: gymId, occurredAt: options.clock.now() });
      return next;
    });
  }
  async function completed(gym: Gym, ticket: string) {
    const demo = sandboxSettings(gym?.settings);
    if (!gym || !demo || demo.ticketHash !== hash(ticket) || !demo.ready || demo.kind !== 'private'
      || Date.parse(demo.expiresAt) <= options.clock.now().getTime()) throw new AppError('not_found', 'Not found');
    const gymId = gym.id;
    const [domain] = await system(tx => tx.select().from(gymDomains).where(and(eq(gymDomains.gymId, gymId), eq(gymDomains.kind, 'default'))));
    if (!domain) throw new AppError('not_found', 'Not found');
    return { gymId, origin: `https://${domain.hostname}`, expiresAt: demo.expiresAt,
      kioskToken: options.service.kioskTokenFor(gymId), handoffToken: copyToken(ticket) };
  }
  function assigned(demo: SandboxSettings, ticketHash: string, input: { role: DemoRole; page: string }, now: Date): SandboxSettings {
    return { ...demo, kind: 'private', allocatedAt: now.toISOString(), lastActivityAt: now.toISOString(), expiresAt: idleExpiry(now),
      ticketHash, ticketExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(), copy: input,
      handoffExpiresAt: new Date(now.getTime() + 600_000).toISOString() };
  }
  const liveTicket = (demo: SandboxSettings | null, now: Date) => Boolean(demo?.kind === 'queued' && demo.ticketHash && demo.copy
    && demo.ticketExpiresAt && Date.parse(demo.ticketExpiresAt) > now.getTime());
  const ticketRow = async (ticket: string) => (await system(tx => tx.select().from(gyms)
    .where(eq(demoText('ticketHash'), hash(ticket))).limit(1)))[0];
  async function finishAllocation(gym: Gym) {
    const completed = await update(gym.id, demo => {
      if (!demo.allocationPending || demo.kind !== 'queued' || !demo.ready || !demo.ticketHash || !demo.copy) return demo;
      if (!liveTicket(demo, options.clock.now())) return demo;
      const next = assigned(demo, demo.ticketHash, demo.copy, options.clock.now());
      next.ticketExpiresAt = demo.ticketExpiresAt!;
      delete next.allocationPending;
      return next;
    }, 'demo.allocated');
    gym.settings = { ...settingsOf(gym), demo: completed };
  }
  /** All allocators lock the same pool/queue rows in ID order, and select tickets in arrival order.
   * Only system lifecycle metadata moves between gyms; seeded gym-owned data never moves.
   */
  async function allocateReady(visitor?: { ticket: string; input: { role: DemoRole; page: string } }) {
    const allocated = await system(async tx => {
      const locked = await tx.select().from(gyms).where(inArray(demoText('kind'), ['pool', 'queued']))
        .orderBy(asc(gyms.id)).for('update');
      const now = options.clock.now(), changes: Gym[] = [];
      const waiting = locked.filter(row => row.status === 'active' && liveTicket(sandboxSettings(row.settings), now)
        && !sandboxSettings(row.settings)?.allocationPending)
        .sort((a, b) => queueOrder(a).localeCompare(queueOrder(b)));
      const ready = locked.filter(row => {
        const demo = sandboxSettings(row.settings);
        return row.status === 'active' && demo?.ready && demo.kind === 'pool'
          && Date.parse(demo.expiresAt) > now.getTime();
      }).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      async function save(row: Gym, demo: SandboxSettings) {
        const [saved] = await tx.update(gyms).set({ settings: { ...settingsOf(row), demo }, revision: row.revision + 1, updatedAt: now })
          .where(eq(gyms.id, row.id)).returning();
        Object.assign(row, saved!);
      }
      for (const reservation of waiting) {
        const candidate = ready.shift() ?? (sandboxSettings(reservation.settings)?.ready ? reservation : undefined);
        if (!candidate) break;
        const ticket = sandboxSettings(reservation.settings)!;
        if (candidate.id !== reservation.id) {
          const cleared = { ...ticket, kind: 'pool' as const };
          delete cleared.ticketHash; delete cleared.ticketExpiresAt; delete cleared.copy;
          delete cleared.ticketOrder;
          delete cleared.handoffHash; delete cleared.handoffExpiresAt;
          await save(reservation, cleared);
        }
        const demo = { ...sandboxSettings(candidate.settings)!, kind: 'queued' as const, allocationPending: true,
          ticketHash: ticket.ticketHash!, ticketExpiresAt: ticket.ticketExpiresAt!, ticketOrder: ticket.ticketOrder ?? queueOrder(reservation),
          copy: ticket.copy!, handoffHash: ticket.handoffHash! };
        await save(candidate, demo);
        changes.push(candidate);
      }
      let own: Gym | undefined;
      // A new arrival can only take a remaining pool gym after every older live ticket was served.
      if (visitor && changes.length === waiting.length) {
        const candidate = ready.find(row => sandboxSettings(row.settings)?.kind === 'pool');
        if (candidate) {
          const demo = { ...sandboxSettings(candidate.settings)!, kind: 'queued' as const, allocationPending: true,
            ticketHash: hash(visitor.ticket), ticketExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
            copy: visitor.input, handoffHash: hash(copyToken(visitor.ticket)) };
          await save(candidate, demo); changes.push(candidate); own = candidate;
        }
      }
      return { changes, own };
    });
    // A durable claim stays inaccessible until its gym-scoped private transition and audit commit together.
    // If this process ends here, refill finishes the claim instead of allocating that ticket a second time.
    if (allocated.own) await finishAllocation(allocated.own);
    for (const gym of allocated.changes) {
      if (gym === allocated.own) continue;
      try { await finishAllocation(gym); }
      catch (error) { logError('demo.allocation_failed', { gymId: gym.id }, error); }
    }
    return { gym: allocated.own, count: allocated.changes.length };
  }
  async function progress(ticket: string) {
    requireDemo(options.config);
    const now = options.clock.now().getTime();
    let row = await ticketRow(ticket);
    if (!row) {
      const recovery = await recoveryFor(hash(ticket));
      if (recovery?.demo.ticketExpiresAt && Date.parse(recovery.demo.ticketExpiresAt) > now) {
        return { pending: true as const, ticket, position: 1, retryAfterSeconds: 2 as const };
      }
      // Recovery may have created the new reservation and finished its job between the two reads.
      row = await ticketRow(ticket);
    }
    const demo = sandboxSettings(row?.settings);
    if (!row || !demo || !demo.ticketExpiresAt || Date.parse(demo.ticketExpiresAt) <= now) throw new AppError('not_found', 'Not found');
    if (demo.ready && demo.kind === 'private') return completed(row, ticket);
    const waiting = await system(tx => tx.select({ id: gyms.id, createdAt: gyms.createdAt, order: demoText('ticketOrder'),
      ready: demoText('ready'), started: demoText('seedStartedAt') }).from(gyms)
      .where(and(eq(gyms.status, 'active'), gt(demoText('expiresAt'), new Date(now).toISOString()), or(
        and(eq(demoText('kind'), 'queued'), gt(demoText('ticketExpiresAt'), new Date(now).toISOString())),
        and(eq(demoText('kind'), 'pool'), eq(demoText('ready'), 'false')))))
      .orderBy(asc(gyms.createdAt), asc(gyms.id)));
    waiting.sort((a, b) => (a.order ?? `${a.createdAt.toISOString()}:${a.id}`).localeCompare(b.order ?? `${b.createdAt.toISOString()}:${b.id}`));
    if (!waiting.some(gym => gym.started && gym.ready === 'false')) await wake();
    return { pending: true as const, ticket, position: Math.max(1, waiting.findIndex(gym => gym.id === row.id) + 1), retryAfterSeconds: 2 as const };
  }
  async function recoverSeed(payload: unknown) {
    requireDemo(options.config);
    const input = payload as Partial<SeedRecovery> | null;
    const gymId = idSchema.parse(input?.gymId), demo = sandboxSettings({ demo: input?.demo });
    if (!demo || demo.ready || !demo.seedStartedAt || !['queued', 'pool'].includes(demo.kind ?? '')) throw new Error('Invalid seed recovery');
    const rows = await all(), previous = rows.find(gym => gym.id === gymId);
    let recoveryDemo = demo;
    if (previous) {
      let recoverable = false;
      await update(gymId, current => {
        if (current.ready || !['queued', 'pool', 'retired'].includes(current.kind ?? '')) return current;
        recoverable = true;
        // A ready pool gym may have already taken this reservation's ticket. Never revive the old payload's bearer.
        // A retried recovery finds the gym it retired: keep the payload's kind and expiry, not the retirement time.
        recoveryDemo = current.kind === 'retired' ? { ...current, kind: demo.kind!, expiresAt: demo.expiresAt } : current;
        return { ...current, kind: 'retired', expiresAt: options.clock.now().toISOString() };
      });
      if (!recoverable) return;
      await options.service.expire(gymId);
    }
    if (Date.parse(recoveryDemo.ticketExpiresAt ?? recoveryDemo.expiresAt) <= options.clock.now().getTime()) return;
    // The durable job keeps the ticket across deletion and bootstrap; reserve is idempotent for this recovery.
    if (recoveryDemo.ticketHash && rows.some(gym => gym.id !== gymId && sandboxSettings(gym.settings)?.ticketHash === recoveryDemo.ticketHash)) return;
    await options.service.reserve(recoveryDemo.kind, { gymId, demo: recoveryDemo });
  }
  return {
    showcaseHostname, progress, recoverSeed,
    setWake(callback: () => Promise<void>) { wake = callback; },
    setRecoveryCheckpoint(callback: (recovery: SeedRecovery) => Promise<void>) { checkpoint = callback; },
    setRecoveryLookup(callback: (ticketHash: string) => Promise<SeedRecovery | undefined>) { recoveryFor = callback; },
    async showcase() {
      // The active showcase remains available past its replacement deadline until the swap commits.
      const [gym] = await system(tx => tx.select({ id: gyms.id }).from(gyms)
        .where(and(eq(gyms.status, 'active'), eq(demoText('kind'), 'showcase'), eq(demoText('ready'), 'true'))).limit(1));
      return gym ? `https://${showcaseHostname}/demo#kioskToken=${options.service.kioskTokenFor(gym.id)}` : undefined;
    },
    async request(body: unknown) {
      requireDemo(options.config);
      const input = demoCopyRequest.parse(body), ticket = randomBytes(32).toString('base64url'), now = options.clock.now();
      const { gym } = await allocateReady({ ticket, input });
      if (gym) { await wake(); return completed(gym, ticket); }
      const reservation = await options.service.reserve('queued');
      await update(reservation.gymId, (demo, gym) => ({ ...demo, kind: 'queued', ticketHash: hash(ticket), copy: input, ticketOrder: queueOrder(gym),
        ticketExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(), handoffHash: hash(copyToken(ticket)) }));
      return progress(ticket);
    },
    /** Called only by an install job: the job worker serializes the null-gym lane across processes and renews its lease. */
    async refill() {
      requireDemo(options.config);
      const cleanupFailed = new Set<string>();
      for (let count = 0; count < options.config.maxSandboxes * 4 + 4; count++) {
        const rows = await all(), now = options.clock.now();
        const stale = rows.find(gym => { const demo = sandboxSettings(gym.settings); return !cleanupFailed.has(gym.id) && demo && demo.kind !== 'showcase'
          && (Date.parse(demo.expiresAt) <= now.getTime() || (demo.kind === 'queued' && Date.parse(demo.ticketExpiresAt ?? demo.expiresAt) <= now.getTime())); });
        if (stale) {
          try {
            await update(stale.id, demo => Date.parse(demo.expiresAt) <= now.getTime()
              || (demo.kind === 'queued' && Date.parse(demo.ticketExpiresAt ?? demo.expiresAt) <= now.getTime())
              ? { ...demo, kind: 'retired', expiresAt: now.toISOString() } : demo);
            await options.service.expire(stale.id);
          }
          catch (error) { cleanupFailed.add(stale.id); logError('demo.cleanup_failed', { gymId: stale.id }, error); }
          continue;
        }
        const orphan = rows.find(gym => !sandboxSettings(gym.settings) && /^demo-(?:reservation|replacement)\.[0-9a-f-]{36}@example[.]invalid$/.test(String(settingsOf(gym).bootstrapOwnerEmail ?? '')));
        if (orphan) { await options.service.recover(orphan.id, 'pool'); continue; }
        const claimed = rows.find(gym => !cleanupFailed.has(gym.id) && sandboxSettings(gym.settings)?.allocationPending);
        if (claimed) {
          await finishAllocation(claimed);
          // A claim that can't finish (its ticket expired and cleanup failed) must not take every later iteration.
          if (sandboxSettings(claimed.settings)?.allocationPending) cleanupFailed.add(claimed.id);
          continue;
        }
        if (rows.some(row => liveTicket(sandboxSettings(row.settings), now))
          && rows.some(row => sandboxSettings(row.settings)?.ready && ['pool', 'queued'].includes(sandboxSettings(row.settings)?.kind ?? ''))) {
          if ((await allocateReady()).count) continue;
        }
        const waiting = [...rows].sort((a, b) => queueOrder(a).localeCompare(queueOrder(b)))
          .find(gym => { const demo = sandboxSettings(gym.settings); return gym.status === 'active' && demo && ((demo.kind === 'queued' && demo.ticketHash && demo.copy) || (!demo.ready && demo.kind === 'pool')); });
        if (waiting) {
          const previous = sandboxSettings(waiting.settings)!;
          if (!previous.ready && previous.seedStartedAt) {
            // A previous lease ended mid-seed. Seed steps aren't repeatable: discard the partial gym.
            const recovery = { gymId: waiting.id, demo: previous };
            await checkpoint(recovery);
            try { await recoverSeed(recovery); }
            catch (error) { cleanupFailed.add(waiting.id); logError('demo.cleanup_failed', { gymId: waiting.id }, error); continue; }
            continue;
          }
          if (!previous.ready) await options.service.prepare(waiting.id);
          continue;
        }
        const showcase = rows.find(gym => sandboxSettings(gym.settings)?.kind === 'showcase');
        const replace = !showcase || now.getTime() - Date.parse(sandboxSettings(showcase.settings)!.promotedAt ?? sandboxSettings(showcase.settings)!.seededAt ?? showcase.createdAt.toISOString()) >= day;
        const pool = rows.filter(gym => { const demo = sandboxSettings(gym.settings); return gym.status === 'active' && demo?.kind === 'pool' && demo.ready; });
        if (replace && pool[0]) {
          const next = pool[0];
          await system(async tx => {
            const locked = await tx.select().from(gyms).where(inArray(gyms.id, showcase ? [showcase.id, next.id] : [next.id])).orderBy(asc(gyms.id)).for('update');
            const candidate = locked.find(gym => gym.id === next.id);
            if (!candidate || candidate.status !== 'active' || sandboxSettings(candidate.settings)?.kind !== 'pool'
              || !sandboxSettings(candidate.settings)?.ready) return;
            if (showcase) {
              const old = locked.find(gym => gym.id === showcase.id);
              if (!old || sandboxSettings(old.settings)?.kind !== 'showcase') return;
              await tx.update(gymDomains).set({ hostname: `retired-${old.id}.${options.config.domain}` }).where(and(eq(gymDomains.gymId, old.id), eq(gymDomains.kind, 'default')));
              await tx.update(gyms).set({ settings: { ...settingsOf(old), demo: { ...sandboxSettings(old.settings)!, kind: 'retired', expiresAt: now.toISOString() } } }).where(eq(gyms.id, old.id));
            }
            await tx.update(gymDomains).set({ hostname: showcaseHostname }).where(and(eq(gymDomains.gymId, next.id), eq(gymDomains.kind, 'default')));
            await tx.update(gyms).set({ settings: { ...settingsOf(candidate), demo: { ...sandboxSettings(candidate.settings)!, kind: 'showcase', promotedAt: now.toISOString(), expiresAt: new Date(now.getTime() + day).toISOString() } } }).where(eq(gyms.id, next.id));
          });
          continue;
        }
        if (!replace && pool.length >= (options.config.poolSize ?? 5)) return;
        try { await options.service.reserve('pool'); }
        catch (error) { if (error instanceof AppError && error.code === 'rate_limited') return; throw error; }
      }
    },
    async handoff(gymId: string, token: string, clientIp: string) {
      let target: { role: DemoRole; page: string } | undefined;
      let original: SandboxSettings | undefined;
      await update(gymId, demo => {
        if (demo.kind !== 'private' || !demo.ready || demo.handoffHash !== hash(token) || !demo.copy
          || Date.parse(demo.handoffExpiresAt ?? '') <= options.clock.now().getTime()) throw new AppError('not_found', 'Not found');
        target = demo.copy;
        original = demo;
        const rest = { ...demo };
        delete rest.handoffHash; delete rest.handoffExpiresAt;
        return rest;
      });
      let response: Response;
      try {
        response = await options.service.login(gymId, { role: target!.role }, clientIp);
        if (response.status >= 400) throw new AppError('unavailable', 'Demo login failed');
      } catch (error) {
        // A failed login must leave the original bearer usable, without overwriting a newer lifecycle state.
        await update(gymId, demo => demo.kind === 'private' && demo.ready && !demo.handoffHash
          && demo.ticketHash === original!.ticketHash && demo.allocatedAt === original!.allocatedAt
          ? { ...demo, handoffHash: original!.handoffHash!, handoffExpiresAt: original!.handoffExpiresAt! } : demo);
        throw error;
      }
      return { response, redirect: target!.page, kioskToken: options.service.kioskTokenFor(gymId) };
    },
    async touch(gymId: string, knownGym?: Gym) {
      const gym = knownGym?.id === gymId ? knownGym : (await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId))))[0];
      const demo = sandboxSettings(gym?.settings), now = options.clock.now();
      if (!demo || demo.kind !== 'private' || !demo.allocatedAt || Date.parse(demo.expiresAt) <= now.getTime()
        || now.getTime() - Date.parse(demo.lastActivityAt ?? demo.allocatedAt) < 300_000) return;
      const current = await update(gymId, (current, gym) => gym.status !== 'active' || current.kind !== 'private'
        || Date.parse(current.expiresAt) <= now.getTime()
        || now.getTime() - Date.parse(current.lastActivityAt ?? current.allocatedAt!) < 300_000
        ? current : { ...current, lastActivityAt: now.toISOString(),
          expiresAt: new Date(Math.min(Date.parse(current.allocatedAt!) + day, Date.parse(idleExpiry(now)))).toISOString() });
      if (knownGym?.id === gymId) knownGym.settings = { ...settingsOf(knownGym), demo: current };
    },
    async eligible(gymId: string) {
      const [gym] = await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
      const demo = sandboxSettings(gym?.settings);
      return Boolean(gym && gym.status === 'active' && (!demo || (demo.ready && (!demo.kind || demo.kind === 'private') && Date.parse(demo.expiresAt) > options.clock.now().getTime())));
    },
    async jobPolicy(gymId: string, readGym?: () => Promise<Pick<Gym, 'status' | 'settings'> | undefined>): Promise<boolean | 'skip' | 'defer'> {
      const gym = readGym ? await readGym() : (await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId))))[0];
      if (!gym || gym.status !== 'active') return 'skip';
      const demo = sandboxSettings(gym.settings);
      if (!demo) return true;
      if (['showcase', 'retired'].includes(demo.kind ?? '') || Date.parse(demo.expiresAt) <= options.clock.now().getTime()) return 'skip';
      return demo.ready && (!demo.kind || demo.kind === 'private') ? true : 'defer';
    },
    async listEligibleGyms() {
      const rows = await system(tx => tx.select({ id: gyms.id, timezone: gyms.timezone, settings: gyms.settings })
        .from(gyms).where(eq(gyms.status, 'active')));
      return rows.filter(gym => {
        const demo = sandboxSettings(gym.settings);
        return !demo || (demo.ready && (!demo.kind || demo.kind === 'private') && Date.parse(demo.expiresAt) > options.clock.now().getTime());
      }).map(gym => ({ gymId: gym.id, timezone: gym.timezone }));
    },
  };
}
export type DemoPool = ReturnType<typeof createDemoPool>;
