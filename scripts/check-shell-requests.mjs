// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// All three SPA surfaces serve the same built index.html. Count HTML-declared
// resources only; API calls, route imports, PWA files and browser icons are extra.
export function shellRequests(html) {
  const resources = new Set();
  const origin = 'https://gym.example.org';
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    if (/^<link/i.test(tag) && !/\brel=["'](?:stylesheet|modulepreload|preload)["']/i.test(tag)) continue;
    const source = /\b(?:src|href)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (source) resources.add(new URL(source, origin).href);
  }
  const counted = [...resources].filter((source) => {
    const url = new URL(source);
    return url.origin === origin && !url.pathname.startsWith('/assets/');
  });
  const requests = { resources: resources.size, counted: 1 + counted.length };
  // Leave at least half the 50-request window for runtime requests and shared IPs.
  if (requests.counted >= 25) throw new Error(`SPA shell uses ${requests.counted} Cloudflare-counted requests; keep below 25 (rule limit 50).`);
  return requests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const counts = shellRequests(readFileSync(process.argv[2] ?? 'apps/web/dist/index.html', 'utf8'));
  for (const surface of ['admin', 'portal', 'kiosk']) {
    console.log(`/${surface}: HTML + ${counts.resources} declared resources; ${counts.counted} counted by the Cloudflare rule (before runtime requests).`);
  }
}
