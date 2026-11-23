// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { goLiveChecklistResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { errorHandler } from '../../core/errors.js';
import { setLogSink } from '../../core/log.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGoLiveService, type GoLiveService } from './go-live.js';
import { createGoLiveRoutes } from './go-live.routes.js';

const database = useTestDatabase(), factory = createFactories(database), scope = database.forGym;
const clock = new TestClock('2026-11-02T12:00:00Z');
const failingPayments = async () => { throw new Error('private key'); };
const workingSms = async () => ({ source: 'gym' as const, unreadable: false });

function captureLogs() {
  const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
  return { lines, entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>), restore: () => setLogSink(previous) };
}
const item = (checklist: Awaited<ReturnType<GoLiveService['checklist']>>, id: string) => checklist.items.find((entry) => entry.id === id)!;
async function fixture(stripeConfig: string | null = null) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { billingEnabled: false, memberEmailsEnabled: false, memberSmsEnabled: false, stripeConfig });
  const userId = (await factory('authUser', gymId)).id;
  const revision = async () => (await scope(gymId, (tx) => tx.select({ revision: gyms.revision }).from(gyms).where(eq(gyms.id, gymId))))[0]!.revision;
  return { gymId, userId, revision, context: { gymId, actor: { kind: 'user' as const, userId } } };
}
function app(service: GoLiveService, gymId: string, userId: string) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId, userId, roles: ['owner'] }, clock, requestId: 'test' });
    await next();
  });
  server.onError(errorHandler);
  createServerRegistry({ routes: createGoLiveRoutes(service) }).mount(server, authorize, new Set());
  return server;
}

describe('go-live read failures', () => {
  it('falls back to a stored Stripe setting when the payments read fails in the checklist', async () => {
    const f = await fixture('encrypted-stripe-config');
    const service = createGoLiveService({ scope, clock, smtpConfigured: async () => false, paymentsConfigured: failingPayments });
    const logs = captureLogs();
    try {
      const checklist = await service.checklist(f.gymId);
      expect(item(checklist, 'stripe_ready').status).toBe('ready');
      expect(logs.entries()).toEqual([{ time: expect.any(String), level: 'warn', event: 'settings.go_live.read_failed',
        gymId: f.gymId, read: 'payments', error: 'Error' }]);
      expect(logs.lines.join('\n')).not.toContain('private key');
    } finally { logs.restore(); }
  });

  it('needs attention when the payments read fails and no Stripe setting is stored', async () => {
    const f = await fixture(null);
    const service = createGoLiveService({ scope, clock, smtpConfigured: async () => false, paymentsConfigured: failingPayments });
    const logs = captureLogs();
    try {
      const checklist = await service.checklist(f.gymId);
      expect(item(checklist, 'stripe_ready').status).toBe('needs_attention');
      expect(logs.entries()).toHaveLength(1);
      expect(logs.entries()[0]).toMatchObject({ event: 'settings.go_live.read_failed', gymId: f.gymId, read: 'payments', error: 'Error' });
    } finally { logs.restore(); }
  });

  it.each(['memberSmsEnabled', 'memberEmailsEnabled'] as const)('saves %s while the payments read fails and audits it once', async change => {
    const f = await fixture(null);
    const service = createGoLiveService({ scope, clock, smtpConfigured: async () => false, paymentsConfigured: failingPayments, smsStatus: workingSms });
    const logs = captureLogs();
    try {
      const after = await service.update(f.context, { revision: await f.revision(), [change]: true });
      expect(after[change]).toBe(true);
      expect(item(after, 'stripe_ready').status).toBe('needs_attention');
      expect(await scope(f.gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.go_live.updated')))).toHaveLength(1);
    } finally { logs.restore(); }
  });

  it('refuses billing after a failed payments read, logs it, and changes nothing', async () => {
    const f = await fixture('encrypted-stripe-config');
    const service = createGoLiveService({ scope, clock, smtpConfigured: async () => false, paymentsConfigured: failingPayments });
    const revision = await f.revision(), logs = captureLogs();
    try {
      await expect(service.update(f.context, { revision, billingEnabled: true })).rejects.toMatchObject({
        code: 'unavailable', details: { billingEnabled: ['read_failed'] },
      });
      expect(logs.entries()).toEqual([{ time: expect.any(String), level: 'warn', event: 'settings.go_live.read_failed',
        gymId: f.gymId, read: 'payments', error: 'Error' }]);
      const [gym] = await scope(f.gymId, (tx) => tx.select().from(gyms).where(eq(gyms.id, f.gymId)));
      expect(gym).toMatchObject({ billingEnabled: false, revision });
      expect(await scope(f.gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.go_live.updated')))).toEqual([]);
    } finally { logs.restore(); }
  });

  it('refuses texts after a failed SMS read, logs it, and changes nothing', async () => {
    const f = await fixture(null);
    const service = createGoLiveService({ scope, clock, smtpConfigured: async () => false, smsStatus: async () => { throw new Error('private sms key'); } });
    const revision = await f.revision(), logs = captureLogs();
    try {
      await expect(service.update(f.context, { revision, memberSmsEnabled: true })).rejects.toMatchObject({
        code: 'unavailable', details: { memberSmsEnabled: ['read_failed'] },
      });
      expect(logs.entries()).toEqual([{ time: expect.any(String), level: 'warn', event: 'settings.go_live.read_failed',
        gymId: f.gymId, read: 'sms', error: 'Error' }]);
      expect(logs.lines.join('\n')).not.toContain('private sms key');
      const [gym] = await scope(f.gymId, (tx) => tx.select().from(gyms).where(eq(gyms.id, f.gymId)));
      expect(gym).toMatchObject({ memberSmsEnabled: false, revision });
      expect(await scope(f.gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.go_live.updated')))).toEqual([]);
    } finally { logs.restore(); }
  });

  it('answers the checklist route when the payments read fails', async () => {
    const f = await fixture('encrypted-stripe-config');
    const service = createGoLiveService({ scope, clock, smtpConfigured: async () => false, paymentsConfigured: failingPayments });
    const logs = captureLogs();
    try {
      const response = await app(service, f.gymId, f.userId).request('/api/settings/go-live');
      expect(response.status).toBe(200);
      expect(goLiveChecklistResponseSchema.safeParse(await response.json()).success).toBe(true);
      expect(logs.entries()).toHaveLength(1);
      expect(logs.entries()[0]).toMatchObject({ event: 'settings.go_live.read_failed', gymId: f.gymId, read: 'payments', error: 'Error' });
    } finally { logs.restore(); }
  });
});
