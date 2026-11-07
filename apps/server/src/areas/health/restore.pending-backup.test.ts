// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, uuidv7 } from '@plaingym/db';
// Test-only pool: restart the app with the replacement key after rotating with every app pool closed.
// eslint-disable-next-line no-restricted-imports
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { openSecret } from '../../core/secrets.js';
import { authConfig } from '../../infra/auth/config.js';
import { createIntegrationsService, type IntegrationsOptions } from '../settings/integrations.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

describe.each(['rotation', 'restore'] as const)('pending backup credentials after %s', (operation) => {
  const f = useRestoreFixture();
  it('preserves the pending key and unrelated settings, and confirms using the new app key', async () => {
    const gymId = uuidv7(), accessKeyId = randomBytes(12).toString('hex'), secretAccessKey = randomBytes(24).toString('hex');
    const gym = await f.make('gyms', gymId, { settings: { other: { keep: true }, integrations: { other: 'kept' } } });
    const owner = await f.make('authUser', gymId);
    const context = { gymId, actor: { kind: 'user', userId: owner.id } } as const;
    const env = { TENANCY: 'single', AUTH_PASSWORD_LOGIN: 'auto', AUTH_SECRET: 'pending-backup-test-auth-secret-long-enough' };
    const service = (key: Buffer, scope: NonNullable<IntegrationsOptions['scope']>) => createIntegrationsService({
      key, scope, env, config: authConfig(env, false), clock: f.clock,
      origin: async () => 'https://gym.invalid', hasPassword: async () => false, checkDestination: async () => {},
    });
    const pending = await service(f.oldKey, f.source.forGym).createBackupKey(context, { revision: gym.revision,
      destination: { endpoint: 'https://storage.invalid', region: 'auto', bucket: 'backups', accessKeyId, secretAccessKey } });
    if (operation === 'restore') {
      const snapshot = await f.backup().snapshot();
      await f.restore().restore(snapshot.id, f.identity);
    } else {
      await f.source.app.close(); await f.source.system.close();
      await f.sourceMaintenance.rotateKey(f.oldKey, f.currentKey);
      // Retry recognizes the pending envelope as already rotated too.
      expect((await f.sourceMaintenance.rotateKey(f.oldKey, f.currentKey)).rewritten).toBe(0);
      await f.sourceMaintenance.restoreAppConnect();
    }
    const connection = openConnection(operation === 'restore' ? f.target.appUrl : f.source.appUrl, 1);
    try {
      const scope = scopedDatabase(connection.db).forGym;
      const [before] = await scope(gymId, (tx) => tx.select().from(gyms).where(eq(gyms.id, gymId)));
      expect((before!.settings as { other: { keep: boolean } }).other.keep).toBe(true);
      const result = await service(f.currentKey, scope).confirmBackupKey(context, { revision: before!.revision, privateKey: pending.privateKey });
      expect(result.backups?.configured).toBe(true);
      const [after] = await scope(gymId, (tx) => tx.select().from(gyms).where(eq(gyms.id, gymId)));
      const settings = after!.settings as { other: { keep: boolean }; integrations: { other: string; backup?: unknown } };
      expect(settings.other.keep && settings.integrations.other === 'kept' && settings.integrations.backup === undefined).toBe(true);
      expect(after!.backupPublicKey === pending.publicKey).toBe(true);
      const opened = openSecret(f.currentKey, { secretClass: 's3_config', owner: gymId }, after!.s3Config!);
      expect(opened.version).toBe('v2');
      const credentials = JSON.parse(opened.plaintext) as { accessKeyId: string; secretAccessKey: string };
      // Boolean assertions ensure a failure never prints keys, ciphertext or decrypted credentials.
      expect(credentials.accessKeyId === accessKeyId && credentials.secretAccessKey === secretAccessKey).toBe(true);
    } finally { await connection.close(); }
  }, 60_000);
});
