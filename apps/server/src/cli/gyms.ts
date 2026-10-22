// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { forSystem, gyms, gymDomains, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { gymTimezoneSchema, currencySchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../core/clock.js';
import { normalizeHostname, tenancyMode, type TenancyMode } from '../core/tenancy.js';
import { encryptSecret, parseEncryptionKey } from '../core/secrets.js';
import type { Command } from './index.js';
export interface CreateGymInput { name: string; slug: string; hostname: string; ownerEmail: string; timezone: string; currency: string; }
export interface OwnerInvitation { gymId: string; email: string; origin: string; expiresAt: Date; }
/** The invitation must be persisted using the supplied system transaction; delivery happens after commit. */
export type InviteOwner = (tx: Transaction, input: OwnerInvitation) => Promise<{ invitationUrl: string }>;
export function createGymService(options: { mode?: TenancyMode; system?: typeof forSystem; clock?: Clock; key: Buffer; inviteOwner: InviteOwner }) {
  const mode = options.mode ?? tenancyMode(), system = options.system ?? forSystem, clock = options.clock ?? defaultClock;
  return async (input: CreateGymInput) => {
    if (mode !== 'multi') throw new AppError('forbidden', 'Gym creation requires TENANCY=multi');
    const hostname = normalizeHostname(input.hostname), email = input.ownerEmail.trim().toLowerCase();
    if (!hostname || !input.name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new AppError('invalid_request', 'Invalid gym details');
    const timezone = gymTimezoneSchema.parse(input.timezone), currency = currencySchema.parse(input.currency);
    // TODO(CCR): use an audited bootstrap transaction once the scoped database API supports system-row creation with a gym audit.
    return system(async (tx) => {
      const [gym] = await tx.insert(gyms).values({ name: input.name.trim(), slug: input.slug, timezone, currency,
        qrKey: encryptSecret(options.key, 'qr_key', randomBytes(32).toString('base64url')),
        createdAt: clock.now(), updatedAt: clock.now() }).returning({ id: gyms.id });
      await tx.insert(gymDomains).values({ gymId: gym!.id, hostname, kind: 'default', verifiedAt: clock.now() });
      const invitation = await options.inviteOwner(tx, { gymId: gym!.id, email, origin: 'https://' + hostname,
        expiresAt: new Date(clock.now().getTime() + 24 * 60 * 60 * 1000) });
      return { gymId: gym!.id, ...invitation };
    });
  };
}
export function createGymsCommand(provision?: (input: CreateGymInput) => Promise<{ gymId: string; invitationUrl: string }>): Command {
  return { id: 'gyms', description: 'Create a gym and its owner invitation', async run(args, io) {
    if (args[0] !== 'create' || args.length !== 7) { io.stderr('Usage: gyms create <slug> <hostname> <owner-email> <name> <timezone> <currency>'); return 2; }
    try {
      const create = provision ?? createGymService({ key: parseEncryptionKey(process.env.APP_ENCRYPTION_KEY ?? ''),
        // TODO(CCR): connect the owner invitation provisioning API once the auth contract supplies it.
        inviteOwner: async () => { throw new AppError('unavailable', 'Owner invitation provisioning is not configured'); } });
      const result = await create({ slug: args[1]!, hostname: args[2]!, ownerEmail: args[3]!, name: args[4]!, timezone: args[5]!, currency: args[6]! });
      io.stdout(JSON.stringify(result)); return 0;
    } catch (error) { io.stderr(error instanceof AppError ? error.message : 'Unable to create gym'); return 1; }
  } };
}
export const commands: readonly Command[] = [createGymsCommand()];
