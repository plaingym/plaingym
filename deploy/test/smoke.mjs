// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const image = process.argv[2];
assert.ok(image, 'Usage: node deploy/test/smoke.mjs IMAGE');
const temporary = mkdtempSync(join(tmpdir(), 'plaingym-image-'));
const project = 'plaingym-image-' + randomUUID();
const envFile = join(temporary, '.env');
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project, APP_IMAGE: image,
  GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'test@example.org',
  HTTP_PORT: '127.0.0.1:0', HTTPS_PORT: '127.0.0.1:0',
  POSTGRES_DB: 'plaingym', POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  APP_PASSWORD: randomBytes(24).toString('hex'), MAINTENANCE_PASSWORD: randomBytes(24).toString('hex'),
  APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'), AUTH_SECRET: randomBytes(32).toString('hex'), SETUP_TOKEN: randomBytes(32).toString('hex'),
};
writeFileSync(envFile, '', { mode: 0o600 });
const docker = (args, options = {}) => execFileSync('docker', args, {
  env, encoding: 'utf8', timeout: 180_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
const prefix = ['compose', '--project-directory', root, '--env-file', envFile, '-p', project, '-f', join(root, 'compose.yaml')];
const compose = (args, options) => docker([...prefix, ...args], options);
const sql = (query) => compose(['exec', '-T', 'postgres', 'psql', '-X', '-U', 'postgres', '-d', 'plaingym', '-v', 'ON_ERROR_STOP=1', '-qtAc', query]);
const get = (protocol, port, ca, path = '/healthz', accept = 'application/json', payload) => new Promise((resolveRequest, reject) => {
  const request = protocol.request({
    hostname: '127.0.0.1', port, path, servername: 'gym.localhost',
    method: payload ? 'POST' : 'GET',
    headers: { host: 'gym.localhost', accept, ...(payload ? { 'content-type': 'application/json', origin: 'https://gym.localhost' } : {}) }, ca, timeout: 5000,
  }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, body }));
  });
  request.on('timeout', () => request.destroy(new Error('HTTPS timeout')));
  request.on('error', reject);
  request.end(payload ? JSON.stringify(payload) : undefined);
});
try {
  compose(['up', '-d', '--wait', '--wait-timeout', '120']);
  const appId = compose(['ps', '-q', 'app']).trim();
  const configuration = JSON.parse(docker(['inspect', appId]))[0];
  assert.equal(configuration.Config.User, 'node');
  assert.equal(configuration.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(configuration.HostConfig.CapDrop, ['ALL']);
  assert.ok(configuration.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(configuration.HostConfig.Memory, 512 * 1024 * 1024);
  assert.ok(!configuration.Mounts.some((mount) => /docker[.]sock/.test(mount.Destination)));
  assert.ok(configuration.Mounts.some((mount) => mount.Type === 'volume' && mount.Destination === '/var/lib/plaingym'));
  compose(['exec', '-T', 'app', 'sh', '-ec', [
    'test "$(id -u)" -ne 0',
    'test -s /app/assets/fonts/NotoSans-Regular.ttf',
    'test -s /app/public/index.html',
    'test -s /app/packs/bjj.json',
    'test -s /app/packs/judo.json',
    'test -s /app/packs/karate.json',
    'test -s /app/packs/muay-thai.json',
    'test -s /app/packs/functional-fitness.json',
    'test -s /app/THIRD_PARTY_LICENSES',
    'test "$(command -v gym-app)" = /usr/local/bin/gym-app',
    'test -z "$(command -v docker)"',
    'touch /var/lib/plaingym/staging/test && rm /var/lib/plaingym/staging/test',
    'pg_dump --version | grep "18.6"',
    'pg_restore --version | grep "18.6"',
  ].join('\n')]);
  assert.throws(() => compose(['exec', '-T', 'app', 'touch', '/app/should-fail']));
  compose(['exec', '-T', 'app', '/app/deploy/database.sh', 'migrate']);
  assert.equal(Number(sql("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'").trim()), 54);
  assert.equal(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)").trim(), '0');
  compose(['exec', '-T', 'app', 'node', '/app/maintenance.mjs', 'resume']);
  // Actual role drift must fail startup, even while Postgres is healthy.
  sql('ALTER ROLE app BYPASSRLS');
  assert.throws(() => compose(['run', '--rm', '--no-deps', '-T', 'app', 'true']));
  sql('ALTER ROLE app NOBYPASSRLS');
  sql('SET ROLE maintenance; CREATE TABLE deployment_probe(id integer);');
  assert.throws(() => compose(['exec', '-T', 'app', '/app/deploy/database.sh', 'migrate']));
  sql('DROP TABLE deployment_probe');
  compose(['exec', '-T', 'app', '/app/deploy/database.sh', 'roles']);

  const caddyId = compose(['ps', '-q', 'caddy']).trim();
  const caPath = join(temporary, 'root.crt');
  docker(['cp', caddyId + ':/data/caddy/pki/authorities/local/root.crt', caPath]);
  const ca = readFileSync(caPath);
  const httpPort = Number(compose(['port', 'caddy', '80']).trim().split(':').at(-1));
  const httpsPort = Number(compose(['port', 'caddy', '443']).trim().split(':').at(-1));
  const redirect = await get(http, httpPort);
  assert.equal(redirect.status, 308);
  const response = await get(https, httpsPort, ca);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
  const catalog = await get(https, httpsPort, ca, '/api/content-packs/catalog');
  assert.equal(catalog.status, 200);
  const packs = JSON.parse(catalog.body).data;
  assert.deepEqual(packs.map((pack) => pack.id), ['bjj', 'functional-fitness', 'judo', 'karate', 'muay-thai']);
  for (const pack of packs) {
    assert.deepEqual(Object.keys(pack).sort(), ['id', 'name', 'summary', 'version']);
    assert.equal(pack.version, 1);
    assert.ok(pack.summary.length > 0);
  }
  const setup = await get(https, httpsPort, ca, '/setup', 'text/html');
  assert.equal(setup.status, 200);
  assert.match(setup.headers['content-type'], /text\/html/);
  assert.ok(setup.body.includes('/assets/'));
  assert.equal((await get(https, httpsPort, ca, '/api/setup')).status, 200);
  for (const path of ['/api/setup/start', '/api/setup/owner', '/api/setup/restore'])
    assert.equal((await get(https, httpsPort, ca, path, 'application/json', {})).status, 403);
  assert.equal(compose(['exec', '-T', 'app', 'gym-app', 'setup-link']).trim(), 'https://gym.localhost/setup#token=' + env.SETUP_TOKEN);
  const source = await get(https, httpsPort, ca, '/source');
  assert.equal(source.status, 302);
  assert.equal(source.headers.location, process.env.SOURCE_URL ?? 'https://github.com/plaingym/plaingym');
  assert.ok(configuration.Config.Env.includes('APP_VERSION=' + (process.env.VERSION ?? '0.0.0-dev')));
  // gym-app dispatches CLI commands through the same bundle inside the container.
  const cli = spawnSync('docker', [...prefix, 'exec', '-T', 'app', 'gym-app', 'unknown-command'], { encoding: 'utf8', env });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /Unknown command/);
  // Reuse initialized volumes: the role bootstrap must not run a second time.
  compose(['restart', 'postgres', 'app']);
  compose(['up', '-d', '--wait', '--wait-timeout', '90']);
  compose(['exec', '-T', 'app', 'node', '/app/deploy/healthcheck.mjs']);
  console.log('PASS: HTTPS, redirect, roles, boot migrations, forced RLS, image assets, first-boot shell and pack catalog, source link, gym-app CLI, hardening, memory caps, restart.');
} catch (error) {
  try { console.error(compose(['logs', '--no-color', '--tail', '30', 'app'])); }
  catch { /* Preserve the original failure if diagnostics are unavailable. */ }
  throw error;
} finally {
  compose(['down', '--volumes', '--remove-orphans']);
  rmSync(temporary, { recursive: true, force: true });
}
