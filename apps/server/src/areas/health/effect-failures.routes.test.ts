// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { exhaustedEffectsResponseSchema, healthContracts } from '@plaingym/shared/contracts';
import { createApp } from '../../core/app.js';
import { authorize } from '../staff/auth.permissions.js';
import { effectDismissed, effectStaffRetried } from '../billing/transitions/effects.js';
import { useExhaustedFixture } from '../billing/transitions/exhausted.fixture.test-helper.js';
import { createStatusProviders } from './status.providers.js';
import { createEffectFailureRoutes } from './effect-failures.routes.js';

const { fixture } = useExhaustedFixture(), roles = ['owner', 'admin', 'coach', 'front_desk'] as const;
type Fixture = Awaited<ReturnType<typeof fixture>>;
function request(f: Fixture, role: typeof roles[number], action: 'listEffectFailures' | 'retryEffect' | 'dismissEffect', effectId?: string) {
  return createApp({ clock: f.clock, authorize, skipSetup: true,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] } }); await next(); },
    contributions: { routes: createEffectFailureRoutes(f.effects) },
  }).request(healthContracts[action].path, effectId === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effectId }),
  });
}
it.each(roles)('requires settings.manage for all three effect routes: %s', async role => {
  const f = await fixture(), retryId = await f.create(), dismissId = await f.create('staff_notice');
  const allowed = role === 'owner' || role === 'admin';
  for (const [action, id] of [['listEffectFailures', undefined], ['retryEffect', retryId], ['dismissEffect', dismissId]] as const) {
    const response = await request(f, role, action, id);
    expect(response.status).toBe(allowed ? 200 : 403);
    if (allowed) expect(response.headers.get('cache-control')).toBe('no-store');
    if (allowed && action === 'listEffectFailures') expect(exhaustedEffectsResponseSchema.parse(await response.json()).data).toHaveLength(2);
  }
  expect(await f.audits(effectStaffRetried, retryId)).toHaveLength(allowed ? 1 : 0);
  expect(await f.audits(effectDismissed, dismissId)).toHaveLength(allowed ? 1 : 0);
});
it('keeps the list gym-scoped and returns 404 for both actions on foreign and unknown effects', async () => {
  const f = await fixture(), foreign = await fixture(), id = await foreign.create();
  expect(exhaustedEffectsResponseSchema.parse(await (await request(f, 'owner', 'listEffectFailures')).json()).data).toEqual([]);
  for (const action of ['retryEffect', 'dismissEffect'] as const) {
    expect((await request(f, 'owner', action, id)).status).toBe(404);
    expect((await request(f, 'owner', action, uuidv7())).status).toBe(404);
    expect((await request(f, 'owner', action, 'invalid')).status).toBe(400);
  }
  expect(await foreign.effects.exhaustedEffects(foreign.gymId)).toHaveLength(1);
  expect(await f.rows()).toEqual([]);
});
it('keeps its Health tile in error after the job is deleted, and clears it on dismissal', async () => {
  const f = await fixture(), id = await f.create(); await f.removeJobs();
  const provider = createStatusProviders({ scope: f.options.scope }).find(provider => provider.id === 'invoice_effects')!;
  const read = () => provider.read({ gymId: f.gymId, roles: ['owner'], clock: f.clock });
  expect(await read()).toMatchObject({ status: 'error', details: { exhausted: 1 } });
  expect((await request(f, 'admin', 'dismissEffect', id)).status).toBe(200);
  expect(await read()).toMatchObject({ status: 'healthy', details: { exhausted: 0 } });
  expect((await request(f, 'owner', 'retryEffect', id)).status).toBe(409);
});
