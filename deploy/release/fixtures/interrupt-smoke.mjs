// SPDX-License-Identifier: AGPL-3.0-only
// Runs the compatibility smoke in its own process group, so the tests can send a real Ctrl-C or SIGTERM to it, or a
// signal to this process alone. SMOKE_FIXTURE_MODE picks what is blocked when the signal arrives: the smoke itself
// (`interrupt`, for SMOKE_FIXTURE_BLOCK_MS, 60 s by default) or the first Docker call cleaning up after a passing
// smoke (`cleanup`). `fail` fails the smoke.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdInterrupts, interruptExitCode, runChild, smokePreviousImage } from '../previous-smoke.mjs';

const tree = process.env.SMOKE_FIXTURE_TREE;
const calls = process.env.SMOKE_FIXTURE_CALLS;
const mode = process.env.SMOKE_FIXTURE_MODE;
mkdirSync(join(tree, 'deploy/test'), { recursive: true });
// The never-run block holds the markers the current-files run needs, so a second deployment's smoke can start.
writeFileSync(join(tree, 'deploy/test/smoke.mjs'), `import { join } from 'node:path';
const root = 'original';
const project = 'original';
const envFile = 'unused';
const env = {
  GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'test@example.org',
};
const prefix = [];
const compose = (args, options) => docker([...prefix, ...args], options);
if (false) {
  for (const file of ['Caddyfile', 'demo/Caddyfile']) { void file; }
  assert.equal(docker([]), 'fixture');
  assert.equal(configuration.Config.User, 'node');
  compose(['exec', '-T', 'app', '/app/deploy/database.sh', 'migrate']);
  assert.equal(compose(['exec', '-T', 'caddy', 'cat', '/proc/sys/net/ipv4/tcp_wmem']).trim(), 'fixture');
  const caPath = 'fixture'; void caPath;
}
if (process.env.SMOKE_FIXTURE_MODE === 'fail') process.exit(1);
if (process.env.SMOKE_FIXTURE_MODE === 'cleanup') process.exit(0);
console.log('ready');
setTimeout(() => {}, Number(process.env.SMOKE_FIXTURE_BLOCK_MS ?? 60_000));
`);

/** A real child that stays blocked until the group signal reaches it. */
const block = () => runChild(process.execPath, ['-e', "console.log('ready'); setTimeout(() => {}, 60_000)"],
  { stdio: 'inherit', timeout: 60_000, killSignal: 'SIGKILL' });

/** Keep Docker out of the test, while the smoke itself still runs as a real blocked child. */
let blocked = false;
const run = async (binary, args, options) => {
  appendFileSync(calls, `${binary} ${args.join(' ')}\n`);
  if (binary === 'docker') {
    if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Config: { Env: [] } }]);
    if (mode === 'cleanup' && args[0] === 'ps') return 'owned-container\n';
    // Only the first removal blocks: the pass after an interrupted one removes the container at once.
    if (mode === 'cleanup' && args[0] === 'rm' && !blocked) {
      blocked = true;
      await block();
    }
    return '';
  }
  return runChild(binary, args, options);
};

holdInterrupts();
try {
  await smokePreviousImage('previous-image', 'migrate-image', tree, 'fixture-ref', run);
} catch (error) {
  const code = interruptExitCode(error);
  if (code === undefined) throw error;
  console.error(error.message);
  if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = code;
}
