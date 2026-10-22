// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
export function fileStream(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
}
export function bytesStream(value: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
export async function saveStream(path: string, stream: ReadableStream<Uint8Array>): Promise<{ sha256: string; size: number }> {
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256'); let size = 0;
  try {
    for await (const chunk of stream) {
      hash.update(chunk); size += chunk.byteLength;
      let offset = 0;
      while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
    }
    await file.sync();
    return { sha256: hash.digest('hex'), size };
  } finally { await file.close(); }
}
export async function fileDigest(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}
export async function readJson(path: string, limit = 16 * 1024 * 1024): Promise<unknown> {
  if ((await stat(path)).size > limit) throw new Error('Metadata exceeds size limit');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
/** Sync the new file and rename it before syncing its parent (Linux data volumes). */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await saveStream(temporary, bytesStream(JSON.stringify(value)));
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}
export function childPath(root: string, name: string): string {
  const result = resolve(join(root, name));
  if (!result.startsWith(resolve(root) + sep)) throw new Error('Path escapes staging');
  return result;
}
