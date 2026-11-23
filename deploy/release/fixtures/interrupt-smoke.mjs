// SPDX-License-Identifier: AGPL-3.0-only
// Runs the compatibility smoke in its own process group, so the tests can send a real Ctrl-C or SIGTERM to it.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdInterrupts, interruptExitCode, smokePreviousImage } from '../previous-smoke.mjs';

const tree = process.env.SMOKE_FIXTURE_TREE;
const calls = process.env.SMOKE_FIXTURE_CALLS;
mkdirSync(join(tree, 'deploy/test'), { recursive: true });
writeFileSync(join(tree, 'deploy/test/smoke.mjs'), `import { join } from 'node:path';
const root = 'original';
const project = 'original';
const envFile = 'unused';
const env = {
  GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'test@example.org',
};
const prefix = [];
const compose = (args, options) => docker([...prefix, ...args], options);
if (process.env.SMOKE_FIXTURE_MODE === 'fail') process.exit(1);
console.log('ready');
setTimeout(() => {}, 60_000);
`);

/** Keep Docker out of the test, while the smoke itself still runs as a real blocked child. */
const run = (binary, args, options) => {
  appendFileSync(calls, `${binary} ${args.join(' ')}\n`);
  if (binary === 'docker') {
    if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Config: { Env: [] } }]);
    return '';
  }
  return execFileSync(binary, args, options);
};

holdInterrupts();
try {
  smokePreviousImage('previous-image', 'migrate-image', tree, 'fixture-ref', run);
} catch (error) {
  const code = interruptExitCode(error);
  if (code === undefined) throw error;
  console.error(error.message);
  process.exitCode = code;
}
