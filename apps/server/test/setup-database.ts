// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const run = promisify(execFile);

// Provides one database URL to every test file; files share that database.
export default async function setupDatabase(project: TestProject) {
  if (process.env.DATABASE_URL) {
    project.provide('databaseUrl', process.env.DATABASE_URL);
    return;
  }

  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'plaingym-test-'));
  const projectName = 'plaingym-test-' + randomUUID();
  const appPassword = randomBytes(24).toString('hex');
  const envFile = join(directory, '.env');
  // No dependency on the checkout's .env; passwords stay in the child environment.
  await writeFile(envFile, '', { mode: 0o600 });
  const env = {
    ...process.env,
    POSTGRES_DB: 'plaingym_test',
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    APP_PASSWORD: appPassword,
    MAINTENANCE_PASSWORD: randomBytes(24).toString('hex'),
    POSTGRES_PORT: '0',
  };
  const compose = [
    'compose', '--project-directory', root, '--env-file', envFile,
    '--project-name', projectName, '-f', join(root, 'compose.dev.yaml'),
  ];
  const command = (args: string[]) => run('docker', [...compose, ...args], {
    cwd: root, env, windowsHide: true, timeout: 120_000,
  });
  const cleanup = async () => {
    try {
      await command(['down', '--volumes', '--remove-orphans']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  try {
    console.log('Starting disposable PostgreSQL for tests: ' + projectName);
    await command(['up', '-d', '--wait', '--wait-timeout', '60', 'postgres']);
    const { stdout } = await command(['port', 'postgres', '5432']);
    const address = stdout.trim();
    if (!/^127[.]0[.]0[.]1:[0-9]+$/.test(address)) {
      throw new Error('Expected a loopback-only PostgreSQL port, received: ' + address);
    }
    project.provide('databaseUrl', `postgres://app:${appPassword}@${address}/plaingym_test`);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
