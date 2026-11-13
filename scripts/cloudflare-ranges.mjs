// SPDX-License-Identifier: AGPL-3.0-only
// Refreshes the canonical deploy/cloudflare-ranges.txt used by the installer and packaged with the app.
// Run by hand: `node scripts/cloudflare-ranges.mjs`, review the diff, and ship it in a release.
import { writeFileSync } from 'node:fs';
import { isIP } from 'node:net';

const root = new URL('../', import.meta.url);
const today = new Date().toISOString().slice(0, 10);
async function list(url, family) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const ranges = (await response.text()).split('\n').map((line) => line.trim()).filter(Boolean);
  for (const range of ranges) {
    const [base, prefix, extra] = range.split('/');
    const bits = family === 4 ? 32 : 128;
    if (extra !== undefined || isIP(base) !== family || !/^\d+$/.test(prefix ?? '') || Number(prefix) > bits) {
      throw new Error(`Unexpected range from ${url}: ${range}`);
    }
  }
  if (ranges.length === 0) throw new Error(`${url} listed no ranges`);
  return ranges;
}
const ranges = [...await list('https://www.cloudflare.com/ips-v4', 4), ...await list('https://www.cloudflare.com/ips-v6', 6)];
writeFileSync(new URL('deploy/cloudflare-ranges.txt', root), [
  '# SPDX-License-Identifier: AGPL-3.0-only',
  `# Cloudflare's published proxy ranges (https://www.cloudflare.com/ips-v4 and ips-v6), pinned on ${today}.`,
  '# Refresh with `node scripts/cloudflare-ranges.mjs`. This is the canonical list for the installer and app;',
  '# the server build copies it into the image beside server.mjs. A changed list ships in a release.',
  ...ranges, ''].join('\n'));
console.log(`Wrote ${ranges.length} ranges. Review the diff before committing.`);
