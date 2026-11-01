// SPDX-License-Identifier: AGPL-3.0-only
import { access } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { regularFontUrl } from './assets.js';
import { runCommandLine, startRuntime } from './core/runtime.js';
import { logInfo } from './core/log.js';
import { shutdown } from './shutdown.js';

const args = process.argv.slice(2);
if (args.length) {
  // `gym-app <command>` runs this bundle with arguments instead of starting the server. Its output is for the person
  // running it: results on stdout, messages on stderr as plain text.
  process.exitCode = await runCommandLine(args, { stdout: (line) => process.stdout.write(line + '\n'), stderr: (line) => process.stderr.write(line + '\n') });
} else {
  // Fail startup when a packaged asset is missing.
  await access(regularFontUrl);
  const runtime = await startRuntime();
  const server = serve({
    fetch: runtime.app.fetch,
    hostname: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
  }, (info) => {
    logInfo('server.listening', { host: info.address, port: info.port });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown({ server, runtime }));
}
