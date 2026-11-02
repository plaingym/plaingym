// SPDX-License-Identifier: AGPL-3.0-only
import { logError } from '../core/log.js';
import { BackupsNotSetUpError } from './restore.js';

/**
 * A failed maintenance command: a plain line for the person at the terminal, and the cause through the
 * logger, which drops the message (it can quote a database URL, a path or a key). Only a command name
 * that looks like one is logged.
 */
export function reportMaintenanceFailure(args: readonly string[], error: unknown, stderr: (line: string) => void = (line) => process.stderr.write(line + '\n')): void {
  // Its message is fixed text that names what to do, never a value.
  stderr(error instanceof BackupsNotSetUpError ? error.message : 'Maintenance command failed; check configuration and restore state');
  const command = args[0];
  logError('cli.maintenance_failed', { command: command !== undefined && /^[a-z][a-z-]{0,31}$/.test(command) ? command : null }, error);
}
