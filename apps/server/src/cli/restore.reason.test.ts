// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decrypt, encrypt, generateIdentity, identityToRecipient } from '../infra/age/index.js';
import { createS3Client, S3BackupObjectStore } from '../infra/storage/index.js';
import { s3Server } from '../infra/storage/s3-server.test-helper.js';
import { commands, reportRestoreResume } from './restore.js';
import { RestoreFailure, restoreFailureReason } from './restore.reason.js';

const secrets = ['SECRETACCESSKEYVALUE', 'ACCESSKEYIDVALUE', 'SECRETFIELDVALUE', 'DBPASSWORD', 'AGE-SECRET-KEY-1', 'bucket-name-value'];
const restore = commands.find((command) => command.id === 'restore')!;
let directory: string, bucket: Awaited<ReturnType<typeof s3Server>>, identity: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'restore-reasons-'));
  bucket = await s3Server();
  identity = await generateIdentity();
  await writeFile(join(directory, 'identity.txt'), identity + '\n');
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('BACKUP_STAGING_DIR', join(directory, 'staging'));
  vi.stubEnv('UPLOADS_DIR', join(directory, 'uploads'));
  // Never connected: every case here fails before the restore takes the database lock.
  vi.stubEnv('MAINTENANCE_DATABASE_URL', 'postgres://maintenance:DBPASSWORD@127.0.0.1:1/unused');
});
afterAll(async () => { vi.unstubAllEnvs(); await bucket.close(); await rm(directory, { recursive: true, force: true }); });
beforeEach(() => { bucket.objects.clear(); bucket.state.fail = undefined; });
afterEach(() => { bucket.state.fail = undefined; });

const validConfig = () => ({ bucket: 'bucket-name-value', endpoint: bucket.endpoint, region: 'auto',
  accessKeyId: 'ACCESSKEYIDVALUE', secretAccessKey: 'SECRETACCESSKEYVALUE', identityFile: join(directory, 'identity.txt') });
async function run(config: unknown, snapshot: string = randomUUID(), path = join(directory, 'restore.json')) {
  if (config !== undefined) await writeFile(path, typeof config === 'string' ? config : JSON.stringify(config));
  const lines: string[] = [];
  const code = await restore.run([snapshot, '--config', path], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
  const text = lines.join('\n');
  for (const secret of secrets) expect(text.includes(secret)).toBe(false);
  expect(text.includes(directory)).toBe(false);
  return { code, text };
}
const resumeLine = 'A verified restore can be resumed with the maintenance CLI';

describe('the command-line restore says why it failed', () => {
  it('reports an unreadable configuration without its path', async () => {
    const path = join(directory, 'missing.json');
    const { code, text } = await run(undefined, randomUUID(), path);
    expect(code).toBe(1);
    expect(text).toBe('Restore failed: Cannot read the restore configuration file (ENOENT)');
  });
  it('says a configuration file that is not JSON is not JSON, without quoting it', async () => {
    const { text } = await run('{ "secretAccessKey": SECRETFIELDVALUE');
    expect(text).toContain('is not valid JSON');
    expect(text).toContain('Restore failed: ');
  });
  it('names the fields that are wrong, never their values', async () => {
    const { text } = await run({ ...validConfig(), endpoint: 'SECRETFIELDVALUE', bucket: '', unknownField: 'SECRETFIELDVALUE' });
    expect(text).toContain('has invalid fields: bucket, endpoint, (1 unrecognized field)');
    expect(text).not.toContain('unknownField');
  });
  it('counts a field it does not know instead of naming it, since the name comes from the file', async () => {
    const { text } = await run({ ...validConfig(), AKIAPASTEDSECRETNAME: 'x', other: 'y' });
    expect(text).toContain('has invalid fields: (2 unrecognized fields)');
    expect(text).not.toContain('AKIAPASTEDSECRETNAME');
  });
  it('names a missing field', async () => {
    const config: Record<string, unknown> = validConfig();
    delete config.identityFile;
    const { text } = await run(config);
    expect(text).toContain('has invalid fields: identityFile');
  });
  it('refuses a snapshot ID that is not a UUID, and one the file contradicts', async () => {
    expect((await run(validConfig(), 'SECRETFIELDVALUE')).text).toContain('Restore failed: SNAPSHOT is not a snapshot ID (a UUID)');
    expect((await run({ ...validConfig(), snapshotId: randomUUID() })).text)
      .toContain('Restore failed: The restore configuration names a different snapshot than SNAPSHOT');
  });
  it('reports an unreadable key file without its path', async () => {
    const identityFile = join(directory, 'no-such-key.txt');
    const { text } = await run({ ...validConfig(), identityFile });
    expect(text).toContain('Restore failed: Cannot read the key file (ENOENT)');
  });
  it('says the snapshot is not in the bucket', async () => {
    const { code, text } = await run(validConfig());
    expect(code).toBe(1);
    expect(text).toContain('Restore failed: Snapshot not found in the bucket');
  });
  it('gives the S3 error code when the bucket refuses or fails the request', async () => {
    bucket.state.fail = () => true;
    const { text } = await run(validConfig());
    expect(text).toMatch(/^Restore failed: The backup bucket answered with error [A-Za-z][A-Za-z0-9_.: -]*$/);
  }, 30_000);
  it('says the bucket could not be reached, not that it answered, when the endpoint refuses the connection', async () => {
    const { code, text } = await run({ ...validConfig(), endpoint: 'http://127.0.0.1:1' });
    expect(code).toBe(1);
    expect(text).toMatch(/^Restore failed: Cannot reach the backup bucket( \([A-Za-z0-9_.:-]+\))?$/);
    expect(text).not.toContain('answered');
  }, 30_000);
  it('names the missing environment variable', async () => {
    vi.stubEnv('BACKUP_STAGING_DIR', '');
    try { expect((await run(validConfig())).text).toContain('Restore failed: Missing BACKUP_STAGING_DIR'); }
    finally { vi.stubEnv('BACKUP_STAGING_DIR', join(directory, 'staging')); }
  });
  it('says the app key is invalid without printing it', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', 'SECRETFIELDVALUE');
    try { expect((await run(validConfig())).text).toBe('Restore failed: Invalid current app key'); }
    finally { vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32)); }
  });
});

describe('restoreFailureReason', () => {
  it("says the key doesn't open the snapshot when another key's file is decrypted", async () => {
    const other = await generateIdentity();
    const sealed = await encrypt(await identityToRecipient(other), new Response('snapshot').body!);
    const failure = await decrypt(identity, sealed).then((body) => new Response(body).text()).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const reason = restoreFailureReason(failure);
    expect(reason).toBe("The key doesn't open this snapshot");
    expect(reason).not.toContain('AGE-SECRET-KEY');
  });
  it('gives the S3 error code of a real client error', async () => {
    const client = createS3Client({ endpoint: bucket.endpoint, maxAttempts: 1, credentials: { accessKeyId: 'ACCESSKEYIDVALUE', secretAccessKey: 'SECRETACCESSKEYVALUE' } });
    try {
      bucket.state.fail = () => true;
      const failure = await new S3BackupObjectStore({ client, bucket: 'bucket-name-value' }).getObject('snapshots/x').then(() => null, (error: unknown) => error);
      const reason = restoreFailureReason(failure);
      expect(reason).toMatch(/^The backup bucket answered with error \S+/);
      for (const secret of secrets) expect(reason).not.toContain(secret);
      // A code the server names is passed through; anything that isn't an identifier is not.
      expect(restoreFailureReason(Object.assign(new Error('Key SECRETFIELDVALUE'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })))
        .toBe('The backup bucket answered with error AccessDenied');
      expect(restoreFailureReason(Object.assign(new Error('x'), { name: 'bad name SECRETFIELDVALUE', $metadata: { httpStatusCode: 403 } })))
        .toBe('The backup bucket answered with error HTTP 403');
      // The SDK adds `$metadata` to errors that never reached a server; those are not an answer.
      expect(restoreFailureReason(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED', $metadata: { attempts: 3 } })))
        .toBe('Cannot reach the backup bucket (ECONNREFUSED)');
      expect(restoreFailureReason(Object.assign(new Error('x'), { $metadata: { attempts: 3 } }))).toBe('Cannot reach the backup bucket');
    } finally { client.destroy(); }
  });
  it('does not expose snapshot record keys from a Zod error', () => {
    const failure = z.strictObject({ a: z.record(z.string(), z.number()) }).safeParse({ a: { SECRETFIELDVALUE: 'SECRETFIELDVALUE' }, c: 'SECRETFIELDVALUE' });
    expect(failure.success).toBe(false);
    expect(restoreFailureReason(failure.error)).toBe("The snapshot's contents are not in a format this version reads");
  });
  it('gives only the error name for any other failure', () => {
    class DiskFullError extends Error { constructor() { super('no space left writing /srv/SECRETFIELDVALUE with DBPASSWORD'); this.name = 'DiskFullError'; } }
    expect(restoreFailureReason(new DiskFullError())).toBe('Unexpected error (DiskFullError)');
    expect(restoreFailureReason(Object.assign(new Error('DBPASSWORD'), { name: 'name with DBPASSWORD' }))).toBe('Unexpected error (Error)');
    expect(restoreFailureReason('SECRETFIELDVALUE')).toBe('Unexpected error (unknown)');
  });
});
describe('durable resume hint', () => {
  it('prints only for an unfinished staged restore', async () => {
    const lines: string[] = [], state = join(directory, 'restore-state.json');
    await reportRestoreResume(line => lines.push(line));
    expect(lines).toEqual([]);
    await writeFile(state, JSON.stringify({ phase: 'verified' }));
    await reportRestoreResume(line => lines.push(line));
    expect(lines).toEqual([resumeLine]);
    expect((await run(undefined, randomUUID(), join(directory, 'missing.json'))).text.endsWith(resumeLine)).toBe(true);
    lines.length = 0;
    await writeFile(state, JSON.stringify({ phase: 'complete' }));
    await reportRestoreResume(line => lines.push(line));
    expect(lines).toEqual([]);
    await writeFile(state, 'invalid journal');
    await reportRestoreResume(line => lines.push(line));
    expect(lines).toEqual([]);
    await rm(state);
  });
});

describe('fixed restore failures', () => {
  it.each([
    'Restored gym receipt is missing',
    'Invalid current app key',
    'Restore staging must be outside uploads',
    'A snapshot object is missing from the bucket',
    'A verified restore is already staged; resume it first',
    'Restore staging and uploads must share a filesystem',
    'Manifest belongs to another snapshot',
    'Manifest and authenticated references disagree',
    'Restore journal does not match staged snapshot',
    'Current install key changed during restore',
    'Upload storage changed during restore',
    'Unexpected uploads directory during restore',
    'Restored uploads tree missing',
    'Backups and restore require maintenance',
    'Usage: restore SNAPSHOT --config PRIVATE_JSON_FILE',
  ])('reports %s', (message) => {
    expect(restoreFailureReason(new RestoreFailure(message))).toBe(message);
  });
});
