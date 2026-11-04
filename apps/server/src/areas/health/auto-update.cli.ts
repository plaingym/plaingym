// SPDX-License-Identifier: AGPL-3.0-only
import { dirname } from 'node:path';
import type { forGym } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { Command } from '../../cli/index.js';
import { clock as defaultClock } from '../../core/clock.js';
import { restoreStagingDirectory } from '../../core/maintenance-credentials.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { listGyms, singleGymId, tenancyMode } from '../../core/tenancy.js';
import { createAutoUpdateSettings, type AutoUpdateSettings } from '../settings/auto-update.js';
import { autoUpdateAttemptSchema, createAutoUpdateAttempts } from './auto-update.js';
import { backupsConfigured } from './restore.config.js';
import { RestoreGate } from './restore.gate.js';

export interface AutoUpdateCommandOptions {
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  scope?: typeof forGym;
  resolveGymId?: () => Promise<string>;
  settings?: AutoUpdateSettings;
  /** Whether this install takes snapshots; the updater needs one before it changes anything. */
  backups?: () => Promise<boolean>;
  /** Whether a restore holds the install (its state file on the data volume). */
  restoring?: () => Promise<boolean>;
  /** Whether the setup wizard has created the install's gym yet. */
  hasGym?: () => Promise<boolean>;
}
const usage = 'Usage: gym-app auto-update check | gym-app auto-update record --at INSTANT --result RESULT [--reason REASON] [--from VERSION] [--to VERSION]';
const flags = { '--at': 'attemptedAt', '--result': 'result', '--reason': 'reason', '--from': 'fromVersion', '--to': 'toVersion' } as const;
/**
 * `gym-app auto-update`: the bridge between the host's nightly `update.sh --patch` and the app, which never holds the
 * Docker socket. The updater runs it in the app container (`docker compose exec`):
 *
 * * `check` prints `restore=…`, then (unless a restore holds the install) `setup=false` before the setup wizard has
 *   created the gym, or `enabled=…`, `backups=…` and the gym's `timezone=…`, one `key=value` per line.
 * * `record` stores one attempt's result for the `automatic_updates` health tile.
 *
 * Single-gym installs only: an install serving several gyms has no updater timer.
 */
export function createAutoUpdateCommand(options: AutoUpdateCommandOptions = {}): Command {
  return { id: 'auto-update', description: 'Read the automatic update setting or record an attempt (for update.sh --patch)', async run(args, io) {
    const env = options.env ?? process.env;
    try {
      if (tenancyMode(env.TENANCY ?? 'single') !== 'single') { io.stderr('Automatic updates run only on a single-gym install'); return 1; }
      const staging = restoreStagingDirectory(env);
      const restoring = options.restoring ?? (async () => staging ? new RestoreGate(dirname(staging)).isClosed() : false);
      const resolveGymId = options.resolveGymId ?? (() => singleGymId());
      const settings = options.settings ?? createAutoUpdateSettings({ ...options.scope ? { scope: options.scope } : {}, clock: options.clock ?? defaultClock });
      if (args.length === 1 && args[0] === 'check') {
        // A restore may be replacing the database: answer before reading it.
        if (await restoring()) { io.stdout('restore=true'); return 0; }
        // A new install has no gym until the wizard's first step: nothing to update yet, and nothing wrong.
        if (!await (options.hasGym ?? (async () => (await listGyms()).length > 0))()) { io.stdout('restore=false\nsetup=false'); return 0; }
        const backups = options.backups ?? (() => backupsConfigured(parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? '')));
        const setting = await settings.get(await resolveGymId());
        io.stdout(['restore=false', 'setup=true', `enabled=${setting.enabled}`, `backups=${await backups()}`, `timezone=${setting.timezone}`].join('\n'));
        return 0;
      }
      if (args[0] === 'record' && args.length % 2 === 1) {
        const input: Record<string, string | null> = { reason: null, fromVersion: null, toVersion: null }, seen = new Set<string>();
        for (let index = 1; index < args.length; index += 2) {
          const key = flags[args[index] as keyof typeof flags];
          if (!key || seen.has(key)) { io.stderr(usage); return 2; }
          seen.add(key);
          input[key] = args[index + 1]!;
        }
        const attempt = autoUpdateAttemptSchema.safeParse(input);
        if (!attempt.success) { io.stderr('Invalid attempt: ' + attempt.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')); return 2; }
        if (await restoring()) { io.stderr('A restore is in progress; nothing was recorded'); return 1; }
        await createAutoUpdateAttempts({ ...options.scope ? { scope: options.scope } : {}, clock: options.clock ?? defaultClock })
          .record(await resolveGymId(), attempt.data);
        io.stdout('Recorded.');
        return 0;
      }
      io.stderr(usage);
      return 2;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : 'Automatic update command failed');
      return 1;
    }
  } };
}
export const commands: readonly Command[] = [createAutoUpdateCommand()];
