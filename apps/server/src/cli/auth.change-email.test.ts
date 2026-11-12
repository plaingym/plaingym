// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The command's effect on the login, its sessions and Google link is the subject.
import { authAccount, authSession, authUser, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createEmailChangeService } from '../infra/auth/email-change.js';
import { createAuthCommands } from './auth.js';

const database = useTestDatabase(), factory = createFactories(database);
beforeAll(() => { vi.stubEnv('AUTH_SECRET', 'change-email-cli-test-secret-at-least-32-characters'); vi.stubEnv('TENANCY', 'single'); });
afterAll(() => { vi.unstubAllEnvs(); });

async function fixture() {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const owner = await factory('staffRoles', gymId, { role: 'owner' }), coach = await factory('staffRoles', gymId, { role: 'coach' });
  await factory('authSession', gymId, { userId: owner.userId });
  await factory('authAccount', gymId, { userId: owner.userId, providerId: 'google', accountId: 'google-' + uuidv7() });
  const emailOf = async (userId: string) => (await database.system.db.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, userId)))[0]!.email;
  const emailChange = createEmailChangeService({ config: { tenancy: 'single' }, database: () => database.system.db });
  const commands = createAuthCommands(() => ({ resolveGymId: async () => gymId, emailChange }));
  const run = async (...args: string[]) => {
    const stdout: string[] = [], stderr: string[] = [];
    const code = await commands[0]!.run(args, { stdout: message => stdout.push(message), stderr: message => stderr.push(message) });
    return { code, stdout, stderr };
  };
  return { gymId, owner, coach, ownerEmail: await emailOf(owner.userId), coachEmail: await emailOf(coach.userId), emailOf, run };
}

describe('gym-app auth change-email', () => {
  it('moves a current owner\'s login at once, ends its sessions, unlinks Google and audits as the system', async () => {
    const f = await fixture();
    expect(await f.run('change-email', f.ownerEmail.toUpperCase(), 'Owner.New@Example.test')).toEqual({ code: 0,
      stdout: ['Sign-in email changed. All sessions ended; sign in with the new address.'], stderr: [] });
    expect(await f.emailOf(f.owner.userId)).toBe('owner.new@example.test');
    expect(await database.system.db.select().from(authSession).where(eq(authSession.userId, f.owner.userId))).toEqual([]);
    expect(await database.system.db.select().from(authAccount).where(eq(authAccount.userId, f.owner.userId))).toEqual([]);
    const audits = await database.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'auth.email_changed')));
    expect(audits).toMatchObject([{ actorKind: 'system', targetId: f.owner.userId }]);
  });

  it('refuses a login that is not a current owner, an address in use, and bad arguments', async () => {
    const f = await fixture();
    expect(await f.run('change-email', f.coachEmail, 'coach.new@example.test')).toMatchObject({ code: 1, stderr: ['Owner account not found'] });
    expect(await f.run('change-email', f.ownerEmail, f.coachEmail)).toMatchObject({ code: 1, stderr: ['Another login uses the new address'] });
    expect(await f.run('change-email', f.ownerEmail, 'not@valid@')).toMatchObject({ code: 1 });
    expect((await f.run('change-email', f.ownerEmail)).code).toBe(2);
    expect(await f.emailOf(f.owner.userId)).toBe(f.ownerEmail);
    expect(await f.emailOf(f.coach.userId)).toBe(f.coachEmail);
  });

  it('is single-gym only', async () => {
    const f = await fixture();
    vi.stubEnv('TENANCY', 'multi');
    try {
      expect(await f.run('change-email', f.ownerEmail, 'multi@example.test')).toMatchObject({ code: 1 });
    } finally { vi.stubEnv('TENANCY', 'single'); }
    expect(await f.emailOf(f.owner.userId)).toBe(f.ownerEmail);
  });
});
