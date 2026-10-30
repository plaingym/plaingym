// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backupRuns, encryptedFields, gyms } from '@plaingym/db';
import { cloneDatabase, useTestDatabase } from '@plaingym/db/testing/database';
// Test-only maintenance connection builds the pre-migration restore fixture.
// eslint-disable-next-line no-restricted-imports
import { openConnection } from '@plaingym/db/client';
import { decryptSecret } from '../../core/secrets.js';
import { generateIdentity, identityToRecipient } from '../../infra/age/index.js';
import { S3Uploads } from '../../infra/storage/index.js';
import { PostgresMaintenance } from './backups.database.js';
import { dockerTools, useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ source: useTestDatabase(), target: useTestDatabase() }, { shared: true });
const { gymId, clock } = f;
let base: Awaited<ReturnType<ReturnType<typeof f.backup>['snapshot']>>;
beforeAll(async () => { base = await f.prepare(() => f.backup().snapshot()); });

describe('install snapshot contents after a restore', { timeout: 60_000 }, () => {
  it('does not reuse blobs encrypted to a previous recipient after public-key rotation', async () => {
    const first = base;
    const newIdentity = await generateIdentity(), newRecipient = await identityToRecipient(newIdentity);
    const second = await f.backup({ recipient: newRecipient }).snapshot();
    expect(second.uploads[0]!.blob).not.toBe(first.uploads[0]!.blob);
    await f.restore().restore(second.id, newIdentity);
  });

  it('captures S3-backed uploads through the same storage interface and restores them locally', async () => {
    const s3Uploads = new S3Uploads({ client: f.client, bucket: 'uploads', gymId, clock });
    await s3Uploads.put(gymId + '/s3-photo', Buffer.from('S3 source bytes'), 'image/png');
    const snapshot = await f.backup({ uploads: async () => new Map([[gymId, s3Uploads]]) }).snapshot();
    await f.restore().restore(snapshot.id, f.identity);
    expect(await new Response(await f.restoredUploads().get(gymId + '/s3-photo')).text()).toBe('S3 source bytes');
  });

  it('restores every registered secret with a new app key and preserves the QR key, uploads, and forced RLS', async () => {
    const snapshot = base;
    await f.restore().restore(snapshot.id, f.identity);
    const { gym, account } = await f.secretRows();
    expect(gym.billingEnabled).toBe(false);
    const values: Record<string, string | null> = {
      stripe_config: gym.stripeConfig, smtp_config: gym.smtpConfig, s3_config: gym.s3Config,
      qr_key: gym.qrKey, backup_blob_key: gym.backupBlobKey,
      oauth_access_token: account.accessToken, oauth_refresh_token: account.refreshToken, oauth_id_token: account.idToken,
    };
    for (const field of encryptedFields) {
      expect(decryptSecret(f.currentKey, field.secretClass, values[field.secretClass]!)).toBe(
        field.secretClass === 'backup_blob_key' ? f.blobKey.toString('hex') :
          field.secretClass === 'qr_key' ? 'stable-qr-secret' :
            field.secretClass.replace('_config', '').replace('oauth_', '').replace('_token', '') + '-test');
      expect(() => decryptSecret(f.oldKey, field.secretClass, values[field.secretClass]!)).toThrow();
    }
    const restored = f.restoredUploads();
    expect(await new Response(await restored.get(gymId + '/photo')).text()).toBe('original upload');
    expect(await restored.get(gymId + '/sentinel')).toBeNull();
    expect(await f.gate().isClosed()).toBe(false);
    // migrate() includes the exact catalog assertion for FORCE RLS, privileges, and table inventory.
    await f.targetMaintenance.migrate();
    const history = await f.source.forSystem((tx) => tx.select().from(backupRuns).where(eq(backupRuns.id, snapshot.id)));
    expect(history[0]?.status).toBe('succeeded');
  });

  it('migrates a pre-schema snapshot forward before reopening the app', async () => {
    const old = await cloneDatabase(inject('testDatabase'));
    try {
      const connection = openConnection(old.maintenanceUrl, 1);
      try {
        await connection.sql.begin(async (tx) => {
          await tx`drop schema public cascade`;
          await tx`drop schema drizzle cascade`;
          await tx`create schema public authorization maintenance`;
          await tx`revoke all on schema public from public`;
          await tx`grant usage on schema public to app`;
          await tx`alter default privileges for role maintenance in schema public grant select, insert, update, delete on tables to app`;
        });
      } finally { await connection.close(); }
      const oldMaintenance = new PostgresMaintenance(old.maintenanceUrl, dockerTools);
      const snapshot = await f.backup({ database: oldMaintenance }).snapshot();
      await f.restore().restore(snapshot.id, f.identity);
      await f.targetMaintenance.migrate();
      expect(await f.target.forSystem((tx) => tx.select().from(gyms))).toHaveLength(0);
    } finally { await old.cleanup(); }
  });
});
