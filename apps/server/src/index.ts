// SPDX-License-Identifier: AGPL-3.0-only
import { access } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { regularFontUrl } from './assets.js';
import { runCommandLine, startRuntime } from './core/runtime.js';

const args = process.argv.slice(2);
if (args.length) {
  // `gym-app <command>` runs this bundle with arguments instead of starting the server.
  process.exitCode = await runCommandLine(args, { stdout: (line) => console.log(line), stderr: (line) => console.error(line) });
} else {
  // Fail startup when a packaged asset is missing.
  await access(regularFontUrl);
  const runtime = await startRuntime();
  const server = serve({
    fetch: runtime.app.fetch,
    hostname: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
  }, (info) => {
    console.log(`PlainGym listening on http://${info.address}:${info.port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close(async (error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
      try { await runtime.stop(); } catch (stopError) { console.error(stopError); process.exitCode = 1; }
    }));
  }
}
