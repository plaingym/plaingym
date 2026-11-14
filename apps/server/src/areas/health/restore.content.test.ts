// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as age from '../../infra/age/index.js';
import { SnapshotContentError } from './backups.content.js';
import { bytesStream, MetadataSizeLimitError, readJson } from './backups.files.js';
import { decryptSnapshot, readSnapshotJson } from './restore.content.js';
import { ageKeyReason } from './restore.failure.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });
it('types the metadata size limit and wraps malformed snapshot JSON with its parser cause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-content-')); directories.push(root);
  const path = join(root, 'manifest.json');
  await writeFile(path, '{');
  await expect(readJson(path, 0)).rejects.toBeInstanceOf(MetadataSizeLimitError);
  await expect(readSnapshotJson(path)).rejects.toMatchObject({ name: 'SnapshotContentError', cause: expect.any(SyntaxError) });
  await expect(readSnapshotJson(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('types a malformed age header and leaves wrong-key errors actionable', async () => {
  const identity = await age.generateIdentity();
  await expect(decryptSnapshot(identity, bytesStream('not an age file'))).rejects.toBeInstanceOf(SnapshotContentError);
  const ciphertext = await age.encrypt(await age.identityToRecipient(await age.generateIdentity()), bytesStream('data'));
  const failure: unknown = await decryptSnapshot(identity, ciphertext).catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(SnapshotContentError);
  expect(ageKeyReason(failure)).toBe("The key doesn't open this snapshot");
});
it('types an authenticated age payload failure during streaming', async () => {
  const identity = await age.generateIdentity();
  const ciphertext = new Uint8Array(await new Response(await age.encrypt(await age.identityToRecipient(identity), bytesStream('data'))).arrayBuffer());
  ciphertext[ciphertext.length - 1]! ^= 1;
  const plaintext = await decryptSnapshot(identity, bytesStream(ciphertext));
  await expect(new Response(plaintext).arrayBuffer()).rejects.toBeInstanceOf(SnapshotContentError);
});
it.each([new TypeError('Code defect'), Object.assign(new Error('Disk failure'), { code: 'EIO' })])('preserves a decryption-path error outside content verification: %s', async failure => {
  vi.spyOn(age, 'decrypt').mockRejectedValueOnce(failure);
  await expect(decryptSnapshot('unused', bytesStream('unused'))).rejects.toBe(failure);
});
it.each([
  ['Invalid age private key', "The key file doesn't hold an age private key"],
  ['Expected one age identity', 'The key file must hold exactly one age private key'],
])('keeps the key diagnostic for %s', (message, reason) => {
  expect(ageKeyReason(new Error(message))).toBe(reason);
});
