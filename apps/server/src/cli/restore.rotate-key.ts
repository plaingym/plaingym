// SPDX-License-Identifier: AGPL-3.0-only
import { logInfo } from '../core/log.js';
import { parseEncryptionKey } from '../core/secrets.js';
import { KeyRotationIncompleteError, KeyRotationSessionsError, UnreadableSecretsError, type PostgresMaintenance } from '../areas/health/backups.database.js';
import type { RestoreGate } from '../areas/health/restore.gate.js';

/** Exit 3 proves a preflight refusal changed nothing. Its message names what to do, never a value. */
export class KeyRotationRefusedError extends Error {
  readonly exitCode: number = 3;
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'KeyRotationRefusedError'; }
}
/** Exit 2 means committed pages may require the new key: the host must keep the app stopped. */
export class KeyRotationPartialError extends KeyRotationRefusedError {
  override readonly exitCode = 2;
}
export interface KeyRotationOptions {
  readonly database: PostgresMaintenance;
  /** `APP_ENCRYPTION_KEY`, the key the stored secrets are under now, and `NEW_APP_ENCRYPTION_KEY`, the one replacing it. */
  readonly currentKey: string | undefined;
  readonly newKey: string | undefined;
  /** The install's restore gate when it keeps restore staging: a rotation never runs during a restore. */
  readonly gate: RestoreGate | null;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}
function key(value: string | undefined, name: string): Buffer {
  try { return parseEncryptionKey(value ?? ''); }
  catch { throw new KeyRotationRefusedError(name + ' must be 64 hex characters'); }
}
/**
 * `maintenance.mjs rotate-key`: re-encrypts every stored secret from the current key to the new one, with the app
 * stopped (`deploy/rotate-key.sh` stops it, runs this, then starts the app with the new key). Run it again with the
 * same two keys after an interruption. It prints counts and, for values neither key opens, where they are; never a
 * key or a value.
 */
export async function rotateKey(options: KeyRotationOptions): Promise<void> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const current = key(options.currentKey, 'APP_ENCRYPTION_KEY'), next = key(options.newKey, 'NEW_APP_ENCRYPTION_KEY');
  if (current.equals(next)) throw new KeyRotationRefusedError('NEW_APP_ENCRYPTION_KEY is the current key; generate a new one');
  if (options.gate && await options.gate.isClosed()) throw new KeyRotationRefusedError('A restore is in progress; let it finish, then rotate the key');
  let complete = false;
  try {
    const { rewritten } = await options.database.rotateKey(current, next);
    complete = true;
    logInfo('secrets.key_rotated', { rewritten });
    stdout('Stored secrets re-encrypted with the new key (' + rewritten + ' values changed)');
  } catch (error) {
    if (complete) throw new KeyRotationPartialError('Stored secrets were rotated; run rotate-key.sh again to finish with the same keys');
    if (error instanceof KeyRotationIncompleteError) throw new KeyRotationPartialError(error.message, { cause: error });
    if (error instanceof KeyRotationSessionsError) throw new KeyRotationRefusedError(error.message);
    if (!(error instanceof UnreadableSecretsError)) throw error;
    for (const value of error.unreadable)
      stderr('Opens with neither key: ' + value.secretClass + ' of ' + (value.secretClass.startsWith('oauth_') ? 'sign-in account ' : 'gym ') + value.owner);
    throw new KeyRotationRefusedError(error.unreadable.length + ' stored secrets open with neither key, so nothing was changed. '
      + 'Check that APP_ENCRYPTION_KEY is the key the install runs with; a setting listed above that is already unreadable can be removed and entered again');
  }
}
/** The one-time step after migrations: stored `v1` secrets become `v2` under the same key. Logs counts only. */
export async function upgradeStoredSecrets(database: PostgresMaintenance, appKey: Buffer): Promise<void> {
  const { rewritten, unreadable } = await database.upgradeSecrets(appKey);
  if (rewritten || unreadable) logInfo('secrets.upgraded', { rewritten, unreadable });
}
