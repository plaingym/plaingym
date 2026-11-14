// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { forGym, forSystem, gyms, gymDomains, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { demoCopyRequest, type DemoRole } from '@plaingym/shared/contracts';
import type { DemoService } from './service.js';
import { requireDemo, sandboxSettings, type DemoConfig, type SandboxSettings } from './config.js';

const day = 86_400_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type Gym = typeof gyms.$inferSelect;
const settingsOf = (gym: Gym) => gym.settings as Record<string, unknown>;
/** Reservations, ready claims and bearer consumption commit under row locks. No seed holds a transaction. */
export function createDemoPool(options: {
  config: DemoConfig; service: DemoService; key: Buffer; clock: Clock;
  scope?: typeof forGym; system?: typeof forSystem;
}) {
  const scope = options.scope ?? forGym, system = options.system ?? forSystem;
  const showcaseHostname = `showcase.${options.config.domain}`;
  let wake: () => Promise<void> = async () => {};
  const all = () => system(tx => tx.select().from(gyms).orderBy(asc(gyms.createdAt), asc(gyms.id)));
  const copyToken = (ticket: string) => createHmac('sha256', options.key).update('demo-copy-v1:' + ticket).digest('base64url');
  const idleExpiry = (now: Date) => new Date(now.getTime() + (options.config.idleHours ?? 2) * 3_600_000).toISOString();
  async function update(gymId: string, change: (demo: SandboxSettings, gym: Gym) => SandboxSettings) {
    return scope(gymId, async tx => {
      const [gym] = await tx.select().from(gyms).where(eq(gyms.id, gymId)).for('update');
      const demo = sandboxSettings(gym?.settings);
      if (!gym || !demo) throw new AppError('not_found', 'Not found');
      const next = change(demo, gym);
      if (next === demo) return demo;
      await tx.update(gyms).set({ settings: { ...settingsOf(gym), demo: next }, revision: gym.revision + 1, updatedAt: options.clock.now() }).where(eq(gyms.id, gymId));
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'demo.lifecycle_updated', targetType: 'gym', targetId: gymId, occurredAt: options.clock.now() });
      return next;
    });
  }
  async function completed(gymId: string, ticket: string) {
    const [gym] = await system(tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
    const demo = sandboxSettings(gym?.settings);
    if (!gym || !demo || demo.ticketHash !== hash(ticket) || !demo.ready || demo.kind !== 'private'
      || Date.parse(demo.expiresAt) <= options.clock.now().getTime()) throw new AppError('not_found', 'Not found');
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
  async function progress(ticket: string) {
    requireDemo(options.config);
    const rows = await all(), now = options.clock.now().getTime();
    const row = rows.find(gym => sandboxSettings(gym.settings)?.ticketHash === hash(ticket));
    const demo = sandboxSettings(row?.settings);
    if (!row || !demo || !demo.ticketExpiresAt || Date.parse(demo.ticketExpiresAt) <= now) throw new AppError('not_found', 'Not found');
    if (demo.ready && demo.kind === 'private') return completed(row.id, ticket);
    const waiting = rows.filter(gym => sandboxSettings(gym.settings)?.kind === 'queued');
    await wake();
    return { pending: true as const, ticket, position: Math.max(1, waiting.findIndex(gym => gym.id === row.id) + 1), retryAfterSeconds: 2 as const };
  }
  return {
    showcaseHostname, progress,
    setWake(callback: () => Promise<void>) { wake = callback; },
    async showcase() {
      const rows = await all();
      const gym = rows.find(row => sandboxSettings(row.settings)?.kind === 'showcase');
      return gym ? `https://${showcaseHostname}/demo#kioskToken=${options.service.kioskTokenFor(gym.id)}` : undefined;
    },
    async request(body: unknown) {
      requireDemo(options.config);
      const input = demoCopyRequest.parse(body), ticket = randomBytes(32).toString('base64url'), now = options.clock.now();
      let id: string | undefined;
      const ready = (row: Gym) => { const demo = sandboxSettings(row.settings);
        return row.status === 'active' && demo?.kind === 'pool' && demo.ready && Date.parse(demo.expiresAt) > now.getTime(); };
      // Recheck eligibility under the gym's row lock; two processes cannot claim one copy.
      for (const candidate of (await all()).filter(ready)) {
        id = await scope(candidate.id, async tx => {
          const [row] = await tx.select().from(gyms).where(eq(gyms.id, candidate.id)).for('update');
          if (!row || !ready(row)) return undefined;
          const demo = assigned(sandboxSettings(row.settings)!, hash(ticket), input, now);
          demo.handoffHash = hash(copyToken(ticket));
          await tx.update(gyms).set({ settings: { ...settingsOf(row), demo }, revision: row.revision + 1, updatedAt: now }).where(eq(gyms.id, row.id));
          await writeAudit(tx, { gymId: row.id, actorKind: 'system', action: 'demo.allocated', targetType: 'gym', targetId: row.id, occurredAt: now });
          return row.id;
        });
        if (id) break;
      }
      if (id) { await wake(); return completed(id, ticket); }
      const reservation = await options.service.reserve('queued');
      await update(reservation.gymId, demo => ({ ...demo, kind: 'queued', ticketHash: hash(ticket), copy: input,
        ticketExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(), handoffHash: hash(copyToken(ticket)) }));
      return progress(ticket);
    },
    /** Called only by an install job: the job worker serializes the null-gym lane across processes and renews its lease. */
    async refill() {
      requireDemo(options.config);
      for (let count = 0; count < options.config.maxSandboxes; count++) {
        const rows = await all(), now = options.clock.now();
        const stale = rows.find(gym => { const demo = sandboxSettings(gym.settings); return demo && demo.kind !== 'showcase' && Date.parse(demo.expiresAt) <= now.getTime(); });
        if (stale) { await options.service.expire(stale.id); continue; }
        const orphan = rows.find(gym => !sandboxSettings(gym.settings) && /^demo-reservation\.[0-9a-f-]{36}@example[.]invalid$/.test(String(settingsOf(gym).bootstrapOwnerEmail ?? '')));
        if (orphan) { await options.service.recover(orphan.id, 'pool'); continue; }
        const waiting = rows.find(gym => { const demo = sandboxSettings(gym.settings); return gym.status === 'active' && demo && ((demo.kind === 'queued' && demo.ticketHash && demo.copy) || (!demo.ready && demo.kind === 'pool')); });
        if (waiting) {
          if (!sandboxSettings(waiting.settings)!.ready) await options.service.prepare(waiting.id);
          await update(waiting.id, demo => demo.kind === 'queued' && demo.ticketHash && demo.copy
            ? { ...assigned(demo, demo.ticketHash, demo.copy, options.clock.now()), handoffHash: demo.handoffHash! }
            : { ...demo, kind: 'pool' });
          continue;
        }
        const showcase = rows.find(gym => sandboxSettings(gym.settings)?.kind === 'showcase');
        const replace = !showcase || now.getTime() - Date.parse(sandboxSettings(showcase.settings)!.seededAt ?? showcase.createdAt.toISOString()) >= day;
        const pool = rows.filter(gym => { const demo = sandboxSettings(gym.settings); return gym.status === 'active' && demo?.kind === 'pool' && demo.ready; });
        if (replace && pool[0]) {
          const next = pool[0];
          await system(async tx => {
            const locked = await tx.select().from(gyms).orderBy(asc(gyms.id)).for('update');
            const candidate = locked.find(gym => gym.id === next.id);
            if (!candidate || sandboxSettings(candidate.settings)?.kind !== 'pool') return;
            if (showcase) {
              const old = locked.find(gym => gym.id === showcase.id)!;
              await tx.update(gymDomains).set({ hostname: `retired-${old.id}.${options.config.domain}` }).where(and(eq(gymDomains.gymId, old.id), eq(gymDomains.kind, 'default')));
              await tx.update(gyms).set({ settings: { ...settingsOf(old), demo: { ...sandboxSettings(old.settings)!, kind: 'retired', expiresAt: now.toISOString() } } }).where(eq(gyms.id, old.id));
            }
            await tx.update(gymDomains).set({ hostname: showcaseHostname }).where(and(eq(gymDomains.gymId, next.id), eq(gymDomains.kind, 'default')));
            await tx.update(gyms).set({ settings: { ...settingsOf(candidate), demo: { ...sandboxSettings(candidate.settings)!, kind: 'showcase', expiresAt: new Date(now.getTime() + day).toISOString() } } }).where(eq(gyms.id, next.id));
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
      await update(gymId, demo => {
        if (demo.kind !== 'private' || !demo.ready || demo.handoffHash !== hash(token) || !demo.copy
          || Date.parse(demo.handoffExpiresAt ?? '') <= options.clock.now().getTime()) throw new AppError('not_found', 'Not found');
        target = demo.copy;
        const rest = { ...demo };
        delete rest.handoffHash; delete rest.handoffExpiresAt;
        return rest;
      });
      const response = await options.service.login(gymId, { role: target!.role }, clientIp);
      return { response, redirect: target!.page, kioskToken: options.service.kioskTokenFor(gymId) };
    },
    async touch(gymId: string) {
      const [gym] = await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
      const demo = sandboxSettings(gym?.settings), now = options.clock.now();
      if (!demo || demo.kind !== 'private' || !demo.allocatedAt || Date.parse(demo.expiresAt) <= now.getTime()
        || now.getTime() - Date.parse(demo.lastActivityAt ?? demo.allocatedAt) < 300_000) return;
      await update(gymId, (current, gym) => gym.status !== 'active' || current.kind !== 'private'
        || Date.parse(current.expiresAt) <= now.getTime()
        || now.getTime() - Date.parse(current.lastActivityAt ?? current.allocatedAt!) < 300_000
        ? current : { ...current, lastActivityAt: now.toISOString(),
          expiresAt: new Date(Math.min(Date.parse(current.allocatedAt!) + day, Date.parse(idleExpiry(now)))).toISOString() });
    },
    async eligible(gymId: string) {
      const [gym] = await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
      const demo = sandboxSettings(gym?.settings);
      return Boolean(gym && gym.status === 'active' && (!demo || (demo.ready && (!demo.kind || demo.kind === 'private') && Date.parse(demo.expiresAt) > options.clock.now().getTime())));
    },
  };
}
export type DemoPool = ReturnType<typeof createDemoPool>;
