// SPDX-License-Identifier: AGPL-3.0-only
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDirectory } from '../areas/health/backups.files.js';
import { RestoreFailure } from '../areas/health/restore.failure.js';

/** Host helper input: decimal config byte count, newline, config bytes, then the private key bytes. */
export async function withRestoreFiles<T>(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, dataDirectory: string,
  restore: (configFile: string) => Promise<T>): Promise<T> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > 65_536) throw new RestoreFailure('Restore input exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks), newline = bytes.indexOf(10);
  if (newline < 1 || newline > 6 || !/^[1-9][0-9]*$/.test(bytes.subarray(0, newline).toString())) throw new RestoreFailure('Invalid restore input');
  const length = Number(bytes.subarray(0, newline).toString()), start = newline + 1;
  if (length > 60_000 || start + length >= bytes.length) throw new RestoreFailure('Invalid restore input');
  let config: unknown;
  try { config = JSON.parse(bytes.subarray(start, start + length).toString('utf8')); }
  catch { throw new RestoreFailure('The restore configuration file is not valid JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new RestoreFailure('Invalid restore configuration');
  await privateDirectory(dataDirectory);
  const directory = await mkdtemp(join(dataDirectory, 'restore-input-'));
  try {
    await chmod(directory, 0o700);
    const keyFile = join(directory, 'backup-key.txt'), configFile = join(directory, 'restore.json');
    await writeFile(keyFile, bytes.subarray(start + length), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ ...config, identityFile: keyFile }), { mode: 0o600 });
    return await restore(configFile);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
