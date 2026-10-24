// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import { generateIdentity, identityToRecipient } from '../../infra/age/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { PostgresMaintenance } from './backups.database.js';
import { configuredBackup } from './restore.config.js';

it('snapshots uploads through the runtime storage resolver, whichever backend the install uses', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-23T12:00:00Z'), source = new FakeUploads(gymId, clock);
  const requested: string[] = [];
  const backup = configuredBackup({ recipient: await identityToRecipient(await generateIdentity()), blobKey: randomBytes(32),
    appEncryptionKey: randomBytes(32), budgetBytes: 1_000_000, gymId,
    destination: { bucket: 'backups', region: 'auto', accessKeyId: 'id', secretAccessKey: 'secret' } },
  new PostgresMaintenance('postgres://maintenance:unused@127.0.0.1:1/unused'), clock, 'staging',
  async (id) => { requested.push(id); return source; });
  try {
    expect(await backup.service.options.uploads()).toEqual(new Map([[gymId, source]]));
    expect(requested).toEqual([gymId]);
  } finally { backup.client.destroy(); }
});
