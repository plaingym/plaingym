// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { loopback } from '../support.js';

/**
 * A forward proxy for browsers without Chromium's host-resolver flag (Firefox, WebKit): every `CONNECT <host>:443` tunnels
 * to the stack's Caddy on its loopback address, so TLS, SNI, Host and the request bytes stay the browser's own. Anything but
 * port 443 is refused.
 */
export async function startProxy(): Promise<{ server: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const proxy: Server = createServer((_request, response) => { response.writeHead(405).end(); });
  proxy.on('connect', (request, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    const port = Number(new URL('https://' + request.url).port || 443);
    if (port !== 443) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = connect(443, loopback, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  // The port the Firefox and WebKit projects launch with (`playwright.config.ts`).
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(Number(process.env.E2E_UX_PROXY_PORT ?? 0), '127.0.0.1', resolve); });
  const { port } = proxy.address() as AddressInfo;
  return { server: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    proxy.close(() => resolve());
  }) };
}
