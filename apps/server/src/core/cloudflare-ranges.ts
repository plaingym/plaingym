// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';

// The build copies the canonical installer list beside server.mjs. Source runs read it from deploy/.
const bundled = new URL('./cloudflare-ranges.txt', import.meta.url);
const source = new URL('../../../../deploy/cloudflare-ranges.txt', import.meta.url);
export const cloudflareRanges: readonly string[] = readFileSync(existsSync(bundled) ? bundled : source, 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
