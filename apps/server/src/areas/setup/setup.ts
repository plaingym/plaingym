// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, forSystem, gyms, plans, chargeTypes, memberships, invoices, revisionGuard, assertRevised, writeAudit, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { SetupOwnerRequest, SetupGymDetails, SetupPacksRequest, SetupWebsiteRequest, SetupSmtpRequest, SetupGoogleRequest, SetupDecisionRequest, SetupStripeRequest, SetupBackupRequest, SetupBackupConfirmRequest, SetupFinishRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { reserveGym } from '../../core/tenancy-bootstrap.js';
import { createOwnerService, type ProvisionOwner } from '../staff/auth.owner.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { createSmtpResolver, encryptSmtpConfig, sendSmtpTest, storedSmtpFromRequest, type SendSmtpTest } from '../settings/smtp.js';
import { encryptGoogleConfig, requireGoogleClient, type CheckGoogle } from '../settings/google-login.js';
import { requireBackupDestination, type CheckBackupDestination } from '../settings/backup-destination.js';
import { googleFromEnvironment } from '../../infra/auth/google.js';
import { backupColumns, backupKeyPair, newBlobKey, recipientOf } from './backup-key.js';
import { loadContentPacks } from '../ranks/packs.loader.js';
import { createContentPackService } from '../ranks/packs.js';
import { setupTestMessage } from '../../emails/setup/setup.js';
import { processAlive, processStart, type ProcessLease } from './setup.process.js';
import { createStripeStep } from './stripe-step.js';

/** `googleSkipped` and `backupsLater` record the owner's decisions so a reopened wizard resumes past them. */
interface Progress { completedSteps: number[]; completed: boolean; ownerId?: string; backupRecipient?: string; googleSkipped?: boolean; backupsLater?: boolean; }
type Gym = typeof gyms.$inferSelect;
const initial = (): Progress => ({ completedSteps: [0], completed: false });
function progress(gym: Gym): Progress {
  const settings = gym.settings as { setup?: Progress; bootstrapOwnerEmail?: string };
  const value = settings.setup ?? (gym.slug === 'setup' && gym.name === 'My gym' && settings.bootstrapOwnerEmail ? initial() : undefined);
  if (!value || value.completed) throw new AppError('not_found', 'Setup is unavailable');
  return value;
}
function present(gym?: Gym) {
  const state: Progress = gym ? progress(gym) : { completedSteps: [], completed: false };
  const first = [0, 1, 2, 3, 4, 5, 6, 7].find((step) => !state.completedSteps.includes(step)) ?? 8;
  // Backups set up later: the wizard resumes at the last step, which offers a way back to them.
  return { currentStep: Math.min(8, first === 7 && state.backupsLater ? 8 : first),
    completedSteps: state.completedSteps, completed: state.completed, revision: gym?.revision ?? 1,
    googleSkipped: state.googleSkipped === true, backupsLater: state.backupsLater === true };
}
const missing = () => new AppError('not_found', 'Setup is unavailable');

export function createSetupService(options: {
  /** The runtime's own key, origin and environment; setup reads nothing from the process environment. */
  key: Buffer; origin: string; env: NodeJS.ProcessEnv; clock?: Clock; scope?: typeof forGym; system?: typeof forSystem;
  provisionOwner?: ProvisionOwner; sendTest?: SendSmtpTest;
  /** Tests replace the storage probe; production checks write, read and delete permissions. */
  checkDestination?: CheckBackupDestination;
  stripeProvisioner?: Parameters<typeof createStripeStep>[0]['provisioner'];
  /** Tests fake Google's token endpoint; production asks it about each client before saving. */
  checkGoogle?: CheckGoogle;
}) {
  const scope = options.scope ?? forGym, system = options.system ?? forSystem, clock = options.clock ?? defaultClock;
  const env = options.env;
  const stripeStep = createStripeStep({ key: options.key, origin: options.origin, clock, scope, demoMode: env.DEMO_MODE === 'true',
    ...(options.stripeProvisioner ? { provisioner: options.stripeProvisioner } : {}) });
  async function install() {
    if ((env.TENANCY ?? 'single') !== 'single' || env.DEMO_MODE === 'true') throw missing();
    const rows = await system((tx) => tx.select().from(gyms).limit(2));
    if (rows.length > 1) throw missing();
    const pending = rows[0];
    if (pending?.slug === 'setup' && pending.name === 'Restore pending') {
      const lease = (pending.settings as { setupRestoreLease?: ProcessLease & { token: string } }).setupRestoreLease;
      if (lease && !await processAlive(lease)) { await releaseRestore(lease.token); return undefined; }
    }
    if (rows[0]) progress(rows[0]);
    return rows[0];
  }
  async function current(context: MutationContext, revision: number, step: number) {
    return scope(context.gymId, async (tx) => {
      const [gym] = await tx.select().from(gyms).where(eq(gyms.id, context.gymId)).for('update');
      if (!gym) throw missing();
      const state = progress(gym);
      if (context.actor.kind !== 'user' || state.ownerId !== context.actor.userId) throw missing();
      assertRevised(gym.revision === revision ? [gym] : []);
      if (!state.completedSteps.includes(step - 1)) throw new AppError('conflict', 'Complete the preceding setup step');
      return { gym, state };
    });
  }
  async function save(context: MutationContext, revision: number, step: number,
    changes: Partial<Gym> = {}, extra: Partial<Progress> = {}, effect?: (tx: Transaction) => Promise<void>, previousStep = step - 1,
    audit: { action?: string; completeStep?: boolean; before?: (gym: Gym) => Record<string, unknown>; after?: Record<string, unknown> } = {}) {
    return scope(context.gymId, async (tx) => {
      const [before] = await tx.select().from(gyms).where(eq(gyms.id, context.gymId)).for('update');
      if (!before) throw missing();
      const state = progress(before);
      if (context.actor.kind !== 'user' || state.ownerId !== context.actor.userId) throw missing();
      if (!state.completedSteps.includes(previousStep)) throw new AppError('conflict', 'Complete the preceding setup step');
      const guard = revisionGuard(gyms.revision, revision);
      if (changes.currency && changes.currency !== before.currency) {
        for (const table of [plans, chargeTypes, memberships, invoices]) {
          if ((await tx.select({ id: table.id }).from(table).limit(1)).length)
            throw new AppError('conflict', 'Currency cannot change after billing records exist');
        }
      }
      assertRevised(before.revision === revision ? [before] : []);
      await effect?.(tx);
      const next = { ...state, ...extra, completedSteps: extra.completedSteps ?? (audit.completeStep === false ? state.completedSteps
        : [...new Set([...state.completedSteps, step])].sort((a, b) => a - b)) };
      const after = assertRevised(await tx.update(gyms).set({ ...changes,
        settings: { ...before.settings as object, setup: next }, revision: guard.next, updatedAt: clock.now(),
      }).where(and(eq(gyms.id, context.gymId), guard.matches)).returning());
      await writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: context.actor.userId,
        action: audit.action ?? 'setup.step_completed', targetType: 'gym', targetId: context.gymId,
        ...(audit.before ? { before: audit.before(before) } : {}),
        after: { ...(audit.after ?? { step }), revision: after.revision }, occurredAt: clock.now() });
      return after;
    });
  }
  async function releaseRestore(reservation: string) {
    await system(async (tx) => {
      const [row] = await tx.select().from(gyms).where(and(eq(gyms.slug, 'setup'), eq(gyms.name, 'Restore pending'))).for('update');
      if ((row?.settings as { bootstrapOwnerEmail?: string } | undefined)?.bootstrapOwnerEmail === reservation + '@setup.invalid')
        await tx.delete(gyms).where(eq(gyms.id, row!.id));
    });
  }
  return {
    async status() { return present(await install()); },
    async start() {
      const gym = await install();
      if (gym) return present(gym);
      return { ...present(), currentStep: 1, completedSteps: [0] };
    },
    async assertEmpty() { if (await install()) throw missing(); },
    async reserveRestore(reservation = uuidv7(clock.now().getTime())) {
      if (await install()) throw missing();
      // The same unique slug arbitrates owner creation and restore across app processes.
      const lease = { token: reservation, pid: process.pid, started: await processStart(process.pid) };
      await reserveGym({ name: 'Restore pending', slug: 'setup', hostname: new URL(options.origin).hostname,
        ownerEmail: reservation + '@setup.invalid', timezone: 'UTC', currency: 'USD' }, { clock, key: options.key,
        system: async (fn) => system(async (tx) => {
          const result = await fn(tx);
          const [row] = await tx.select().from(gyms).where(and(eq(gyms.slug, 'setup'), eq(gyms.name, 'Restore pending')));
          if (!row) throw missing();
          await tx.update(gyms).set({ settings: { ...row.settings as object, setupRestoreLease: lease } }).where(eq(gyms.id, row.id));
          return result;
        }),
      });
      // The lease commits with reservation, so a crash before the journal is written is recoverable.
      return { reservationId: reservation, release: () => releaseRestore(reservation) };
    },
    releaseRestore,
    async markRestored() {
      const rows = await system((tx) => tx.select({ id: gyms.id }).from(gyms).limit(2));
      if (rows.length !== 1) throw new AppError('unavailable', 'Expected one restored gym');
      const gymId = rows[0]!.id;
      await scope(gymId, async (tx) => {
        const [row] = await tx.select().from(gyms).where(eq(gyms.id, gymId)).for('update');
        if (!row) throw missing();
        const settings = row.settings as { setup?: Progress };
        if (settings.setup?.completed && !row.billingEnabled) return;
        await tx.update(gyms).set({ settings: { ...settings, setup: { ...settings.setup, completed: true, completedSteps: [0, 1, 2, 3, 4, 5, 6, 7, 8] } },
          billingEnabled: false, revision: row.revision + 1, updatedAt: clock.now() }).where(eq(gyms.id, gymId));
        await writeAudit(tx, { gymId, actorKind: 'system', action: 'setup.restore_completed', targetType: 'gym', targetId: gymId, occurredAt: clock.now() });
      });
    },
    async owner(input: SetupOwnerRequest) {
      const existing = await install();
      if (input.password.length > 128) throw new AppError('invalid_request', 'Password must contain 12 to 128 characters');
      if (existing && progress(existing).ownerId) throw missing();
      const gymId = await reserveGym({ name: 'My gym', slug: 'setup', hostname: new URL(options.origin).hostname,
        ownerEmail: input.email, timezone: 'UTC', currency: 'USD' }, { system, clock, key: options.key });
      await scope(gymId, async (tx) => {
        const [gym] = await tx.select().from(gyms).where(eq(gyms.id, gymId)).for('update');
        if (!gym) throw missing();
        const state = (gym.settings as { setup?: Progress }).setup;
        if (!state) await tx.update(gyms).set({ settings: { ...gym.settings as object, setup: initial() }, updatedAt: clock.now() }).where(eq(gyms.id, gymId));
      });
      // Setup explicitly provisions its required password even when the install has SMTP.
      // Per-gym `auto` login still follows the SMTP resolver after setup.
      const provision = options.provisionOwner ?? createOwnerService({ clock,
        accounts: createAccountService({ ...authConfig(env), passwordEnabled: true }), async sendMagicLink() {} });
      const result = await provision({ gymId, ...input, origin: options.origin });
      await scope(gymId, async (tx) => {
        const [gym] = await tx.select().from(gyms).where(eq(gyms.id, gymId)).for('update');
        if (!gym) throw missing();
        const state = progress(gym);
        if (state.ownerId && state.ownerId !== result.userId) throw missing();
        if (!state.ownerId) {
          await tx.update(gyms).set({ settings: { ...gym.settings as object, setup: { ...state, ownerId: result.userId, completedSteps: [0, 1] } },
            revision: gym.revision + 1, updatedAt: clock.now() }).where(eq(gyms.id, gymId));
          await writeAudit(tx, { gymId, actorKind: 'system', action: 'setup.owner_completed', targetType: 'gym', targetId: gymId, occurredAt: clock.now() });
        }
      });
      return { userId: result.userId };
    },
    async gym(context: MutationContext, input: SetupGymDetails) {
      const { revision, ...changes } = input;
      const gym = await save(context, revision, 2, changes);
      return { ...changes, revision: gym.revision };
    },
    async packs(context: MutationContext, input: SetupPacksRequest) {
      await current(context, input.revision, 3);
      const catalog = await loadContentPacks();
      const selected = input.packs.map((chosen) => {
        const pack = catalog.find((item) => item.id === chosen.packId && item.version === chosen.version);
        if (!pack) throw new AppError('invalid_request', 'Unknown content pack');
        return pack;
      });
      // Share the short gym transaction so a stale wizard cannot apply any pack.
      return present(await save(context, input.revision, 3, {}, {}, async (tx) => {
        const service = createContentPackService({ scope: async (_gymId, fn) => fn(tx), clock });
        for (const pack of selected) await service.apply(context, pack);
      }));
    },
    async website(context: MutationContext, input: SetupWebsiteRequest) {
      const { revision, ...changes } = input;
      return present(await save(context, revision, 4, changes));
    },
    async smtp(context: MutationContext, input: SetupSmtpRequest) {
      await current(context, input.revision, 5);
      if (input.choice === 'skip') {
        const gym = await save(context, input.revision, 5, {}, {}, undefined, 4, { after: { step: 5, test: 'not_sent' } });
        return { configured: await createSmtpResolver({ key: options.key, env, scope }).configured(context.gymId), test: 'not_sent' as const, revision: gym.revision };
      }
      const stored = storedSmtpFromRequest(input);
      const sent = await sendSmtpTest(stored, setupTestMessage(input.testTo), options.sendTest);
      await scope(context.gymId, (tx) => writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
        actorUserId: context.actor.kind === 'user' ? context.actor.userId : undefined,
        action: 'setup.email_tested', targetType: 'gym', targetId: context.gymId,
        after: { test: sent ? 'sent' : 'failed' }, occurredAt: clock.now() }));
      if (!sent)
        return { configured: false, test: 'failed' as const, revision: input.revision };
      const gym = await save(context, input.revision, 5, { smtpConfig: encryptSmtpConfig(options.key, context.gymId, stored) }, {}, undefined, 4,
        { after: { step: 5, test: 'sent' } });
      return { configured: true, test: 'sent' as const, revision: gym.revision };
    },
    /**
     * The optional Google page after step 5: stores the gym's own OAuth client, encrypted, and changes no step. Refused
     * when the install's configuration sets Google (it wins) and outside single-gym setup. Neither value is audited.
     */
    async google(context: MutationContext, input: SetupGoogleRequest) {
      if ((env.TENANCY ?? 'single') !== 'single' || env.DEMO_MODE === 'true') throw missing();
      if (googleFromEnvironment(env)) throw new AppError('conflict', 'This install’s configuration sets Google sign-in', { google: ['install_configured'] });
      // Only this setup's owner, at this point and revision, may have a client checked; then Google is asked outside any transaction.
      await current(context, input.revision, 6);
      const credentials = { clientId: input.clientId, clientSecret: input.clientSecret };
      const check = await requireGoogleClient(credentials, options.origin, options.checkGoogle);
      const value = encryptGoogleConfig(options.key, context.gymId, credentials);
      const gym = await save(context, input.revision, 6, { googleConfig: value }, {}, undefined, 5,
        { action: 'setup.google_saved', completeStep: false, before: (before) => ({ source: before.googleConfig ? 'gym' : 'none' }), after: { source: 'gym' } });
      return { configured: true as const, check, revision: gym.revision };
    },
    /**
     * Records a decision so a reopened wizard resumes past it: skipping the Google page (after step 5), setting backups
     * up later (after step 6), or taking that back. Changes no completed step; audited like the steps.
     */
    async decide(context: MutationContext, input: SetupDecisionRequest) {
      const change = input.decision === 'skip_google' ? { googleSkipped: true } : { backupsLater: input.decision === 'backups_later' };
      const needs = input.decision === 'skip_google' ? 5 : 6;
      return present(await save(context, input.revision, needs + 1, {}, change, undefined, needs,
        { action: 'setup.decision_recorded', completeStep: false, after: { decision: input.decision } }));
    },
    /** Step 6 validates the restricted key and registers the webhook outside any transaction. */
    stripe(context: MutationContext, input: SetupStripeRequest) { return stripeStep.configure(context, input); },
    async backups(context: MutationContext, input: SetupBackupRequest) {
      const { state } = await current(context, input.revision, 7);
      await requireBackupDestination(input.destination, context.gymId, options.checkDestination);
      const { privateKey, publicKey } = await backupKeyPair();
      const { destination, s3Config } = backupColumns(options.key, context.gymId, input.destination);
      // Do not activate backups until the owner proves they saved the matching private key.
      const gym = await save(context, input.revision, 7, {
        backupDestination: destination, s3Config,
        backupPublicKey: null, backupBlobKey: newBlobKey(options.key, context.gymId),
        backupRetentionBytes: 8_000_000_000n,
      }, { completedSteps: state.completedSteps.filter((step) => step !== 7), backupRecipient: publicKey });
      return { privateKey, publicKey, revision: gym.revision };
    },
    async confirmBackupKey(context: MutationContext, input: SetupBackupConfirmRequest) {
      const { gym } = await current(context, input.revision, 7);
      const publicKey = await recipientOf(input.privateKey);
      const pending = (gym.settings as { setup: { backupRecipient?: string } }).setup.backupRecipient;
      if (!pending || pending !== publicKey) throw new AppError('invalid_request', 'Backup key does not match');
      const saved = await save(context, input.revision, 7, { backupPublicKey: publicKey });
      return { publicKey, confirmed: true as const, revision: saved.revision };
    },
    async finish(context: MutationContext, input: SetupFinishRequest) {
      if (input.choice !== 'fresh') throw new AppError('invalid_request', 'Choose a fresh start');
      const changes = input.skipBackups ? { backupDestination: null, s3Config: null, backupPublicKey: null, backupBlobKey: null } : {};
      const gym = await save(context, input.revision, 8, { ...changes, billingEnabled: false, memberEmailsEnabled: false },
        { completed: true }, undefined, input.skipBackups ? 6 : 7);
      return { completed: true as const, billingEnabled: false as const, memberEmailsEnabled: false as const, revision: gym.revision };
    },
  };
}
