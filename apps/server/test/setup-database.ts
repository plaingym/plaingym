// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';
import { prepareTemplate } from '../../../packages/db/src/testing/database.js';
const run = promisify(execFile);
function credentialUrl(base: string, user: string, password: string | undefined, variable: string) {
  if (!password) throw new Error('Database tests require ' + variable + ' or the matching bootstrap password');
  const url = new URL(base); url.username = user; url.password = password; return url.toString();
}
export default async function setupDatabase(project: TestProject) {
  if (process.env.DATABASE_URL) {
    const appUrl = process.env.DATABASE_URL;
    const template = await prepareTemplate({
      appUrl,
      maintenanceUrl: process.env.MAINTENANCE_DATABASE_URL ?? credentialUrl(appUrl, 'maintenance', process.env.MAINTENANCE_PASSWORD, 'MAINTENANCE_DATABASE_URL'),
      adminUrl: process.env.TEST_DATABASE_ADMIN_URL ?? credentialUrl(appUrl, 'postgres', process.env.POSTGRES_PASSWORD, 'TEST_DATABASE_ADMIN_URL'),
    });
    project.provide('testDatabase', template.config);
    return template.cleanup;
  }
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'plaingym-test-'));
  const projectName = 'plaingym-test-' + randomUUID();
  const envFile = join(directory, '.env');
  await writeFile(envFile, '', { mode: 0o600 });
  const env = {
    ...process.env, POSTGRES_DB: 'plaingym_test', POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    APP_PASSWORD: randomBytes(24).toString('hex'), MAINTENANCE_PASSWORD: randomBytes(24).toString('hex'), POSTGRES_PORT: '0',
  };
  const compose = ['compose', '--project-directory', root, '--env-file', envFile,
    '--project-name', projectName, '-f', join(root, 'compose.dev.yaml')];
  const command = (args: string[]) => run('docker', [...compose, ...args], { cwd: root, env, windowsHide: true, timeout: 120_000 });
  const cleanup = async () => {
    try { await command(['down', '--volumes', '--remove-orphans']); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
  try {
    console.log('Starting disposable PostgreSQL for tests: ' + projectName);
    await command(['up', '-d', '--wait', '--wait-timeout', '60', 'postgres']);
    const { stdout } = await command(['port', 'postgres', '5432']);
    const address = stdout.trim();
    if (!/^127[.]0[.]0[.]1:[0-9]+$/.test(address)) throw new Error('Expected a loopback-only PostgreSQL test port');
    const template = await prepareTemplate({
      appUrl: `postgres://app:${env.APP_PASSWORD}@${address}/plaingym_test`,
      maintenanceUrl: `postgres://maintenance:${env.MAINTENANCE_PASSWORD}@${address}/plaingym_test`,
      adminUrl: `postgres://postgres:${env.POSTGRES_PASSWORD}@${address}/postgres`,
    });
    project.provide('testDatabase', template.config);
    return async () => { try { await template.cleanup(); } finally { await cleanup(); } };
  } catch (error) { await cleanup(); throw error; }
}
