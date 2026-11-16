// SPDX-License-Identifier: AGPL-3.0-only
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** A capture-only overlay on the UX pass's existing demo install and seed. */
export async function productOverlay() {
  if (process.env.CI) throw new Error('Product screenshots are captured by hand, never in CI');
  const path = fileURLToPath(new URL('../coverage/product-compose.json', import.meta.url));
  await writeFile(path, JSON.stringify({ services: { demo: {
    // Two ready copies satisfy the shared fixture without needing a later scheduler tick under frozen time.
    environment: { NODE_OPTIONS: '--max-old-space-size=256 --import=/capture-clock.mjs', DEMO_POOL_SIZE: '2' },
    volumes: [{ type: 'bind', source: fileURLToPath(new URL('./product-clock.mjs', import.meta.url)), target: '/capture-clock.mjs', read_only: true }],
  } } }));
  return path;
}
