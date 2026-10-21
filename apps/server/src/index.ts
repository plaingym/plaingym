// SPDX-License-Identifier: AGPL-3.0-only
import { access } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { regularFontUrl } from './assets.js';

// Fail startup when a packaged asset is missing.
await access(regularFontUrl);
const server = serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
}, (info) => {
  console.log(`PlainGym listening on http://${info.address}:${info.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }));
}
