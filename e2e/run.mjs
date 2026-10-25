// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, writeFile } from 'node:fs/promises';

const directory = fileURLToPath(new URL('./', import.meta.url));
if (process.argv[2] === '--vm') {
  const { runVm } = await import('./vm/run.mjs');
  await runVm(process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const token = () => randomBytes(32).toString('hex');
const env = { ...process.env, E2E_POSTGRES_PASSWORD: token(), E2E_APP_PASSWORD: token(),
  E2E_MAINTENANCE_PASSWORD: token(), E2E_AUTH_SECRET: token(), E2E_ENCRYPTION_KEY: token(),
  E2E_SETUP_TOKEN: token(), E2E_S3_SECRET: token(), E2E_IMAGE: process.env.E2E_IMAGE ?? 'plaingym:e2e',
  E2E_COMPOSE_PROJECT: 'plaingym-e2e-' + randomBytes(6).toString('hex') };

function command(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: directory, env, stdio: 'inherit', windowsHide: true, ...options });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${binary} exited ${code}`)));
  });
}

async function build() {
  // Only committed source enters the image. This excludes local credentials,
  // dependencies and other worktrees without modifying the application build.
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`, 'archive', 'HEAD'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const docker = spawn('docker', ['build', '-t', env.E2E_IMAGE, '-f', 'deploy/Dockerfile', '-'],
      { cwd: root, env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    archive.stdout.pipe(docker.stdin);
    docker.stdin.on('error', () => {});
    const exits = [archive, docker].map((child) => new Promise((ok, fail) => {
      child.on('error', fail);
      child.on('exit', (code) => code === 0 ? ok() : fail(new Error(`Image build exited ${code}`)));
    }));
    Promise.all(exits).then(resolve, reject);
  });
}
const compose = ['compose', '--project-name', env.E2E_COMPOSE_PROJECT, '--file', 'compose.yaml'];
await mkdir(new URL('./coverage/', import.meta.url), { recursive: true });
await rm(new URL('./coverage/fixtures.json', import.meta.url), { force: true });
await rm(new URL('./coverage/containers.log', import.meta.url), { force: true });
try {
  if (!process.env.E2E_IMAGE) await build();
  await command('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180']);
  await command(process.execPath, ['./node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)]);
} catch (error) {
  // Container diagnostics are useful even when the browser never starts.
  const log = spawn('docker', [...compose, 'logs', '--no-color'], { cwd: directory, env, windowsHide: true });
  const output = [];
  for await (const chunk of log.stdout) output.push(chunk);
  await writeFile(new URL('./coverage/containers.log', import.meta.url), Buffer.concat(output));
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await command('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
  await rm(new URL('./coverage/fixtures.json', import.meta.url), { force: true });
}
