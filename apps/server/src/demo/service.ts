// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { forGym, forSystem, gyms, gymDomains, kioskDevices, uuidv7, writeAudit, RevisionConflictError } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { reserveGym } from '../core/tenancy-bootstrap.js';
import type { GymContext } from '../core/context.js';
import { logError } from '../core/log.js';
import type { GymDeleteService } from '../areas/settings/gym-delete.js';
import { requireDemo, sandboxSettings, type DemoConfig, type SandboxSettings } from './config.js';
import type { DemoLoginTarget } from '@plaingym/shared/contracts';
import type { JoinService } from '../public/pages/join.service.js';

export function createDemoService(options: {
  config: DemoConfig; key: Buffer; clock: Clock; deletion: GymDeleteService;
  identities: { seed(gymId: string): Promise<void>; login(gymId: string, target: DemoLoginTarget, origin: string, clientIp: string): Promise<Response> };
  seed(context: GymContext): Promise<void>; scope?: typeof forGym; system?: typeof forSystem;
}) {
  const scope = options.scope ?? forGym, system = options.system ?? forSystem;
  const kioskTokenFor = (gymId: string) => createHmac('sha256', options.key).update('demo-kiosk-v1:' + gymId).digest('base64url');
  let joinReadiness: Pick<JoinService, 'ready'> | undefined;
  /** The cheap guard every sandbox route needs: the sandbox exists, is ready and hasn't expired. */
  async function live(gymId: string) {
    requireDemo(options.config);
    const [gym] = await scope(gymId, (tx) => tx.select().from(gyms).where(eq(gyms.id, gymId)));
    const settings = sandboxSettings(gym?.settings);
    if (!gym || gym.status !== 'active' || !settings?.ready || Date.parse(settings.expiresAt) <= options.clock.now().getTime())
      throw new AppError('not_found', 'Not found');
    if (settings.kind === 'pool' || settings.kind === 'queued' || settings.kind === 'retired') throw new AppError('not_found', 'Not found');
    return { expiresAt: settings.expiresAt };
  }
  /** Discovery: `live` plus whether the join page would take a member now. Only this runs the readiness queries. */
  async function status(gymId: string) {
    const { expiresAt } = await live(gymId);
    let join = false;
    if (joinReadiness) {
      try { await joinReadiness.ready(gymId); join = true; }
      catch (error) { if (!(error instanceof AppError) || error.code !== 'unavailable') throw error; }
    }
    return { expiresAt, join };
  }
  async function reserve(kind?: SandboxSettings['kind']) {
      assertNoTransaction('demo.create'); requireDemo(options.config);
      const reservationId = uuidv7(options.clock.now().getTime()), now = options.clock.now();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      const hostname = `${randomBytes(16).toString('hex')}.${options.config.domain}`;
      // Unique bounded slots enforce the cap across processes, even in an empty install.
      let id: string | undefined;
      for (let slot = 1; slot <= options.config.maxSandboxes; slot++) {
        try {
          id = await reserveGym({ name: 'Demo academy', slug: `sandbox-${slot}`, hostname,
            ownerEmail: `demo-reservation.${reservationId}@example.invalid`, timezone: 'UTC', currency: 'USD',
          }, { system, clock: options.clock, key: options.key });
          break;
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'conflict') throw error;
        }
      }
      if (!id) throw new AppError('rate_limited', 'Demo capacity reached');
      const gymId = id;
      const kioskToken = kioskTokenFor(gymId);
      await recover(gymId, kind);
      return { gymId, origin: `https://${hostname}`, expiresAt, kioskToken };
  }
  async function recover(gymId: string, kind?: SandboxSettings['kind']) {
    const now = options.clock.now(), kioskToken = kioskTokenFor(gymId);
    await scope(gymId, async tx => {
      const [gym] = await tx.select().from(gyms).where(eq(gyms.id, gymId)).for('update');
      if (!gym) throw new AppError('not_found', 'Not found');
      const existing = sandboxSettings(gym.settings);
      if (!existing) {
        const marker = (gym.settings as { bootstrapOwnerEmail?: unknown }).bootstrapOwnerEmail;
        if (typeof marker !== 'string' || !/^demo-reservation\.[0-9a-f-]{36}@example[.]invalid$/.test(marker)) throw new AppError('not_found', 'Not found');
        await tx.update(gyms).set({ settings: { setupComplete: true, demo: { sandbox: true, ready: false,
          expiresAt: new Date(gym.createdAt.getTime() + 86_400_000).toISOString(), ...(kind ? { kind } : {}) } } }).where(eq(gyms.id, gymId));
      }
      const devices = await tx.select({ id: kioskDevices.id }).from(kioskDevices).limit(1);
      if (!devices.length) {
          const [device] = await tx.insert(kioskDevices).values({ gymId, name: 'Demo kiosk',
            tokenHash: createHash('sha256').update(kioskToken).digest('hex'), createdAt: now }).returning({ id: kioskDevices.id });
          await writeAudit(tx, { gymId, actorKind: 'system', action: 'kiosk.device_registered', targetType: 'kiosk_device', targetId: device!.id, occurredAt: now });
      }
    });
  }
  async function prepare(gymId: string) {
    assertNoTransaction('demo.prepare'); requireDemo(options.config);
    const [initial] = await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
    if (!initial || !sandboxSettings(initial.settings)) throw new AppError('not_found', 'Not found');
        await options.identities.seed(gymId);
        await options.seed({ gymId, timezone: 'UTC', enabledModules: new Set() });
        await scope(gymId, async (tx) => {
          const [gym] = await tx.select().from(gyms).where(eq(gyms.id, gymId)).for('update');
          const demo = sandboxSettings(gym?.settings);
          if (!gym || !demo) throw new AppError('not_found', 'Not found');
          await tx.update(gyms).set({ settings: { ...(gym.settings as object), demo: { ...demo, ready: true, seededAt: options.clock.now().toISOString() } }, updatedAt: options.clock.now() }).where(eq(gyms.id, gymId));
          await writeAudit(tx, { gymId, actorKind: 'system', action: 'demo.ready', targetType: 'gym', targetId: gymId, occurredAt: options.clock.now() });
        });
  }
  return {
    status, live, reserve, recover, prepare, kioskTokenFor,
    /** Integration supplies the same service that serves /join, after composing its dependencies. */
    setJoinReadiness(service: Pick<JoinService, 'ready'>) { joinReadiness = service; },
    async create() {
      const sandbox = await reserve(), { gymId } = sandbox;
      try {
        await prepare(gymId);
        return sandbox;
      } catch (error) {
        logError('demo.provisioning_failed', { gymId }, error);
        try {
          // Seed services can revise the gym (for example, the billing switches).
          const [gym] = await scope(gymId, tx => tx.select({ revision: gyms.revision }).from(gyms).where(eq(gyms.id, gymId)));
          if (gym) await options.deletion.remove(gymId, gym.revision);
        } catch (cleanupError) {
          // Keep the original failure; suspended/unfinished sandboxes remain eligible for expiry cleanup.
          logError('demo.cleanup_failed', { gymId }, cleanupError);
        }
        throw error;
      }
    },
    async login(gymId: string, target: DemoLoginTarget, clientIp: string) {
      await live(gymId);
      const [domain] = await system((tx) => tx.select({ hostname: gymDomains.hostname }).from(gymDomains)
        .where(and(eq(gymDomains.gymId, gymId), eq(gymDomains.kind, 'default'))));
      if (!domain || !domain.hostname.endsWith('.' + options.config.domain)) throw new AppError('not_found', 'Not found');
      return options.identities.login(gymId, target, `https://${domain.hostname}`, clientIp);
    },
    async expire(gymId: string) {
      if (!options.config.enabled) return;
      const [gym] = await scope(gymId, (tx) => tx.select().from(gyms).where(eq(gyms.id, gymId)));
      const settings = sandboxSettings(gym?.settings);
      if (settings?.kind === 'showcase') return;
      const marker = (gym?.settings as { bootstrapOwnerEmail?: string } | undefined)?.bootstrapOwnerEmail;
      const reserved = typeof marker === 'string' && /^demo-reservation\.[0-9a-f-]{36}@example[.]invalid$/.test(marker);
      const expiresAt = settings ? Date.parse(settings.expiresAt) : reserved && gym ? gym.createdAt.getTime() + 24 * 60 * 60 * 1000 : Infinity;
      if (gym && expiresAt <= options.clock.now().getTime()) {
        try { await options.deletion.remove(gymId, gym.revision); }
        catch (error) { if (!(error instanceof RevisionConflictError)) throw error; }
      }
    },
  };
}
export type DemoService = ReturnType<typeof createDemoService>;
