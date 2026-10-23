// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { auditEvents, gyms, uuidv7, RevisionConflictError } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { goLiveChecklistResponseSchema } from '@plaingym/shared/contracts';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from '../staff/auth.permissions.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { encryptSecret, parseEncryptionKey } from '../../core/secrets.js';
import { createGoLiveService } from './go-live.js';
import { createGoLiveRoutes } from './go-live.routes.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-22T12:00:00Z');
const smtpConfigured = vi.fn(async (gymId: string) => { assertNoTransaction('go-live SMTP check'); return gymId === gymA; });
const service = createGoLiveService({ scope: database.forGym, clock, smtpConfigured });
const gymA = uuidv7(), gymB = uuidv7();
let userId: string;
beforeAll(async () => {
  const key = parseEncryptionKey('aa'.repeat(32));
  await factory('gyms', gymA, { name: 'Gym A', stripeConfig: encryptSecret(key, 'stripe_config', 'rk_test_private'),
    backupPublicKey: 'age1publickey', backupDestination: { endpoint: 'https://s3.example.test', region: 'auto', bucket: 'backups' },
    settings: { setup: { completedSteps: [0, 1, 2, 3, 4, 5, 6, 7, 8], completed: true }, privateConfig: 'secret' } });
  await factory('gyms', gymB, { name: 'Gym B', settings: { setup: { completedSteps: [0, 1], completed: false } } });
  userId = (await factory('authUser', gymA)).id;
  await factory('members', gymA, { firstName: 'Ana', lastName: 'Silva' });
  await factory('classTemplates', gymA);
  await factory('members', gymB, { firstName: 'Erased', lastName: 'Member', anonymizedAt: clock.now() });
});
function server(role: StaffRole, gymId = gymA, principalGym = gymId) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId: principalGym, userId, roles: [role] }, clock, requestId: 'test' }); await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createGoLiveRoutes(service) }).mount(app, authorize, new Set());
  return app;
}
const patch = (app: ReturnType<typeof server>, body: unknown) => app.request('/api/settings/go-live', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const status = (checklist: Awaited<ReturnType<typeof service.checklist>>) => Object.fromEntries(checklist.items.map((item) => [item.id, item.status]));

describe('go-live switches and checklist', () => {
  it('reports readiness from this gym only and never exposes credentials', async () => {
    const a = await service.checklist(gymA), b = await service.checklist(gymB);
    expect(status(a)).toEqual({ gym_details: 'ready', members_imported: 'ready', schedule_ready: 'ready', stripe_ready: 'ready',
      cards_collected: 'not_applicable', waivers_signed: 'not_applicable', smtp_ready: 'ready', backup_ready: 'ready',
      webhook_ready: 'not_applicable', reconciliation_complete: 'not_applicable' });
    // Gym B has an unfinished wizard, only an erased member, and nothing configured; gym A's rows never count.
    expect(status(b)).toMatchObject({ gym_details: 'needs_attention', members_imported: 'needs_attention', schedule_ready: 'needs_attention',
      stripe_ready: 'needs_attention', smtp_ready: 'needs_attention', backup_ready: 'needs_attention' });
    expect(a.items.every((item) => item.message && !item.message.includes(':'))).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/rk_test|privateConfig|secret|age1/);
    expect(a).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false });
    await expect(service.checklist(uuidv7())).rejects.toMatchObject({ code: 'not_found' });
  });
  it.each(staffRoles)('allows only go-live managers to read and change the switches (%s)', async (role) => {
    const app = server(role), allowed = role === 'owner' || role === 'admin';
    const read = await app.request('/api/settings/go-live');
    expect(read.status).toBe(allowed ? 200 : 403);
    if (allowed) expect(goLiveChecklistResponseSchema.safeParse(await read.json()).success).toBe(true);
    expect((await patch(app, {})).status).toBe(allowed ? 400 : 403);
    const { revision, memberEmailsEnabled } = await service.checklist(gymA);
    const changed = await patch(app, { revision, memberEmailsEnabled: !memberEmailsEnabled });
    expect(changed.status).toBe(allowed ? 200 : 403);
    if (allowed) expect(goLiveChecklistResponseSchema.parse(await changed.json()).data.memberEmailsEnabled).toBe(!memberEmailsEnabled);
  });
  it('denies another gym principal and leaves that gym untouched', async () => {
    const app = server('owner', gymB, gymA), before = await service.checklist(gymB);
    expect((await app.request('/api/settings/go-live')).status).toBe(403);
    expect((await patch(app, { revision: before.revision, billingEnabled: true })).status).toBe(403);
    expect(await service.checklist(gymB)).toEqual(before);
    const own = await server('owner', gymB).request('/api/settings/go-live');
    expect(goLiveChecklistResponseSchema.parse(await own.json()).data).toEqual(before);
  });
  it('compares revisions and audits only the switches in the same transaction', async () => {
    const before = await service.checklist(gymA);
    const after = await service.update({ gymId: gymA, actor: { kind: 'user', userId } },
      { revision: before.revision, billingEnabled: true, memberEmailsEnabled: false });
    expect(after).toMatchObject({ revision: before.revision + 1, billingEnabled: true, memberEmailsEnabled: false });
    const [row] = await database.forGym(gymA, (tx) => tx.select().from(gyms).where(eq(gyms.id, gymA)));
    expect(row).toMatchObject({ billingEnabled: true, memberEmailsEnabled: false, updatedAt: clock.now() });
    expect((await patch(server('owner'), { revision: before.revision, billingEnabled: false })).status).toBe(409);
    await expect(service.update({ gymId: gymA, actor: { kind: 'system' } }, { revision: before.revision, billingEnabled: false }))
      .rejects.toBeInstanceOf(RevisionConflictError);
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.go_live.updated')));
    const last = audits.at(-1)!;
    expect(last).toMatchObject({ actorKind: 'user', actorUserId: userId, targetId: gymA,
      before: { billingEnabled: false, memberEmailsEnabled: before.memberEmailsEnabled }, after: { billingEnabled: true, memberEmailsEnabled: false } });
    expect(JSON.stringify(audits)).not.toMatch(/rk_test|privateConfig|age1/);
    expect((await service.checklist(gymB)).billingEnabled).toBe(false);
  });
});
