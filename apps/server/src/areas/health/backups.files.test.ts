// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { atomicJson } from './backups.files.js';

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'atomic-json-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

it('replaces a state file that a concurrent reader holds open', async () => {
  const path = join(directory, 'restore-state.json');
  await atomicJson(path, { phase: 'database' });
  // On Windows an open handle blocks the replacing rename until it closes.
  const reader = await open(path, 'r');
  const released = delay(50).then(() => reader.close());
  await atomicJson(path, { phase: 'complete' });
  await released;
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ phase: 'complete' });
  expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});
