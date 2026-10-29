// SPDX-License-Identifier: AGPL-3.0-only
import { crc32, deflateSync } from 'node:zlib';
import { route } from '../../core/registry.js';

export const portalManifest = { id: '/portal', name: 'PlainGym member portal', short_name: 'PlainGym', start_url: '/portal', scope: '/portal', display: 'standalone', background_color: '#ffffff', theme_color: '#163c38',
  icons: [192, 512].map(size => ({ src: `/portal/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' })) };
// No fetch handler or Cache API: personalized responses are never stored for offline use.
export const portalWorker = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));";
function icon(size: number) {
  const chunk = (type: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(data));
    return Buffer.concat([length, data, checksum]);
  };
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x / size, py = y / size;
    const mark = px >= .3 && px < .4 && py >= .25 && py < .75 || px >= .4 && px < .65 && (py >= .25 && py < .35 || py >= .45 && py < .55) || px >= .6 && px < .7 && py >= .3 && py < .5;
    const offset = y * (size * 3 + 1) + 1 + x * 3;
    rows.set(mark ? [255, 255, 255] : [22, 60, 56], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export function createPortalPwaRoutes() {
  return [
    route({ method: 'get', path: '/portal/manifest.webmanifest', permission: { kind: 'public' }, responses: { 200: { description: 'Member portal manifest' } } }, () => new Response(JSON.stringify(portalManifest), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } })),
    route({ method: 'get', path: '/portal/sw.js', permission: { kind: 'public' }, responses: { 200: { description: 'Online-only service worker' } } }, () => new Response(portalWorker, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/portal' } })),
    ...[192, 512].map(size => {
      const png = icon(size);
      return route({ method: 'get', path: `/portal/icon-${size}.png`, permission: { kind: 'public' }, responses: { 200: { description: 'Member portal icon' } } }, () => new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } }));
    }),
  ];
}
