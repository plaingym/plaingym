// SPDX-License-Identifier: AGPL-3.0-only
import { forSystem } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { gymTimezoneSchema, currencySchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../core/clock.js';
import { normalizeHostname, tenancyMode, type TenancyMode } from '../core/tenancy.js';
import { reserveGym } from '../core/tenancy-bootstrap.js';
import { parseEncryptionKey } from '../core/secrets.js';
import { createDefaultOwnerService, type ProvisionOwner, type OwnerBootstrapResult } from '../areas/staff/auth.owner.js';
import type { Command } from './index.js';
export interface CreateGymInput { name: string; slug: string; hostname: string; ownerEmail: string; timezone: string; currency: string; }
export type CreateGymResult = { gymId: string } & OwnerBootstrapResult;
export function createGymService(options: { mode?: TenancyMode; system?: typeof forSystem; clock?: Clock; key: Buffer; provisionOwner: ProvisionOwner }) {
  const mode = options.mode ?? tenancyMode(), system = options.system ?? forSystem, clock = options.clock ?? defaultClock;
  return async (input: CreateGymInput): Promise<CreateGymResult> => {
    if (mode !== 'multi') throw new AppError('forbidden', 'Gym creation requires TENANCY=multi');
    const hostname = normalizeHostname(input.hostname), email = input.ownerEmail.trim().toLowerCase();
    if (!hostname || !input.name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new AppError('invalid_request', 'Invalid gym details');
    const timezone = gymTimezoneSchema.parse(input.timezone), currency = currencySchema.parse(input.currency);
    const gymId = await reserveGym({ ...input, name: input.name.trim(), hostname, ownerEmail: email, timezone, currency }, { system, clock, key: options.key });
    // The reservation commits before identity/owner creation. Identical retries
    // resume it; account and owner writes share a second transaction.
    const owner = await options.provisionOwner({ gymId, email, name: input.name.trim(), origin: 'https://' + hostname });
    return { gymId, ...owner };
  };
}
export function createGymsCommand(provision?: (input: CreateGymInput) => Promise<CreateGymResult>): Command {
  return { id: 'gyms', description: 'Create a gym and email its owner a login link', async run(args, io) {
    if (args[0] !== 'create' || args.length !== 7) { io.stderr('Usage: gyms create <slug> <hostname> <owner-email> <name> <timezone> <currency>'); return 2; }
    try {
      const create = provision ?? createGymService({ key: parseEncryptionKey(process.env.APP_ENCRYPTION_KEY ?? ''), provisionOwner: createDefaultOwnerService() });
      const result = await create({ slug: args[1]!, hostname: args[2]!, ownerEmail: args[3]!, name: args[4]!, timezone: args[5]!, currency: args[6]! });
      io.stdout(JSON.stringify(result)); return 0;
    } catch (error) { io.stderr(error instanceof AppError ? error.message : 'Unable to create gym'); return 1; }
  } };
}
export const commands: readonly Command[] = [createGymsCommand()];
