// SPDX-License-Identifier: AGPL-3.0-only
import { logError } from '../core/log.js';
import { RestoreFailure } from '../areas/health/restore.failure.js';
import { restoreFailureReason } from './restore.reason.js';
import { BackupsNotSetUpError } from './restore.js';
import { KeyRotationRefusedError } from './restore.rotate-key.js';
// The maintenance boundary reports this checked boot diagnostic, without opening a database connection.
// eslint-disable-next-line no-restricted-imports
import { SchemaCompatibilityError } from '@plaingym/db/client';

/**
 * A failed maintenance command: a plain line for the person at the terminal, and the cause through the
 * logger, which drops the message (it can quote a database URL, a path or a key). Only a command name
 * that looks like one is logged.
 */
export function reportMaintenanceFailure(args: readonly string[], error: unknown, stderr: (line: string) => void = (line) => process.stderr.write(line + '\n')): void {
  // Their messages are fixed text that names what to do, plus the schema guard's validated version and snapshot identifiers.
  stderr(error instanceof BackupsNotSetUpError || error instanceof KeyRotationRefusedError || error instanceof SchemaCompatibilityError ? error.message
    : args[0] === 'restore' || args[0] === 'resume' ? 'Restore failed: ' + restoreFailureReason(error)
      : error instanceof RestoreFailure ? error.message
        : 'Maintenance command failed; check configuration and restore state');
  const command = args[0];
  logError('cli.maintenance_failed', { command: command !== undefined && /^[a-z][a-z-]{0,31}$/.test(command) ? command : null }, error);
}
