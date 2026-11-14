// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { cloudflareRanges } from './cloudflare-ranges.js';
import { clientIp, isCloudflareAddress, type ClientIpOptions } from './rate-limit.js';
import type { RequestEnvironment } from './context.js';
import { setLogSink } from './log.js';

const cloudflareEdge = '172.70.1.2', cloudflareEdge6 = '2606:4700:10::ac43:1', visitor = '198.51.100.7';

function resolver(options: ClientIpOptions) {
  const app = new Hono<RequestEnvironment>();
  app.get('/', (context) => context.text(clientIp(context, { peerAddress: () => '172.18.0.4', ...options })));
  return async (headers: Record<string, string>) => (await app.request('/', { headers })).text();
}

it('reads every range of the installer list as a valid CIDR', () => {
  const file = fileURLToPath(new URL('../../../../deploy/cloudflare-ranges.txt', import.meta.url));
  expect(readFileSync(file, 'utf8')).toContain(cloudflareRanges.join('\n'));
  expect(cloudflareRanges.length).toBeGreaterThan(10);
  for (const range of cloudflareRanges) {
    const [address = '', prefix = ''] = range.split('/');
    const family = isIP(address);
    expect(family, range).not.toBe(0);
    expect(/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128), range).toBe(true);
  }
});

it('matches addresses inside Cloudflare ranges only, in both families', () => {
  for (const address of ['173.245.48.1', '173.245.63.255', '104.16.0.0', '104.23.255.255', cloudflareEdge, cloudflareEdge6,
    '2a06:98c7:ffff::1', '::ffff:162.158.1.1']) expect(isCloudflareAddress(address), address).toBe(true);
  for (const address of ['173.245.64.0', '104.32.0.0', '192.0.2.1', visitor, '2a06:98c8::1', '2001:db8::1',
    '::ffff:192.0.2.1', 'not-an-address', '']) expect(isCloudflareAddress(address), address).toBe(false);
});

it('takes CF-Connecting-IP only behind a trusted proxy, with the switch on, from a Cloudflare address', async () => {
  const on = resolver({ trustedProxy: () => true, cloudflare: true });
  expect(await on({ 'x-forwarded-for': cloudflareEdge, 'cf-connecting-ip': visitor })).toBe(visitor);
  expect(await on({ 'x-forwarded-for': cloudflareEdge6, 'cf-connecting-ip': '2001:db8::7' })).toBe('2001:db8::7');
  // The proxy appends the real peer last: a client can't forge its way into Cloudflare's range.
  expect(await on({ 'x-forwarded-for': `${cloudflareEdge}, 192.0.2.50`, 'cf-connecting-ip': visitor })).toBe('192.0.2.50');
  // A forged header from any other peer is ignored.
  expect(await on({ 'x-forwarded-for': '192.0.2.50', 'cf-connecting-ip': visitor })).toBe('192.0.2.50');
  // An invalid or missing header falls back to the forwarded peer.
  expect(await on({ 'x-forwarded-for': cloudflareEdge, 'cf-connecting-ip': 'not-an-address' })).toBe(cloudflareEdge);
  expect(await on({ 'x-forwarded-for': cloudflareEdge })).toBe(cloudflareEdge);
  // Switch off, or no trusted proxy: the header is never read.
  expect(await resolver({ trustedProxy: () => true })({ 'x-forwarded-for': cloudflareEdge, 'cf-connecting-ip': visitor })).toBe(cloudflareEdge);
  expect(await resolver({ cloudflare: true })({ 'x-forwarded-for': cloudflareEdge, 'cf-connecting-ip': visitor })).toBe('172.18.0.4');
});

it('takes the first valid joined address and logs malformed headers at most once a minute across resolvers', async () => {
  vi.useFakeTimers({ now: Date.now() + 120_000 });
  const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
  try {
    const options = { trustedProxy: () => true, cloudflare: true };
    const first = resolver(options), second = resolver(options);
    const headers = (value: string) => ({ 'x-forwarded-for': cloudflareEdge, 'cf-connecting-ip': value });
    // A caller outside the trusted Cloudflare path cannot produce this diagnostic.
    expect(await first({ ...headers('junk'), 'x-forwarded-for': '192.0.2.50' })).toBe('192.0.2.50');
    expect(lines).toHaveLength(0);
    expect(await first(headers(`junk, ${visitor}, 2001:db8::7`))).toBe(visitor);
    expect(await second(headers(` , 2001:db8::7, ${visitor}`))).toBe('2001:db8::7');
    expect(await first(headers('junk, also-junk'))).toBe(cloudflareEdge);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(59_999);
    expect(await second(headers('junk'))).toBe(cloudflareEdge);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(await second(headers('junk'))).toBe(cloudflareEdge);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'client_ip.cloudflare_header_invalid', reason: 'multiple' }),
      expect.objectContaining({ event: 'client_ip.cloudflare_header_invalid', reason: 'invalid' }),
    ]);
    expect(lines.join('\n')).not.toMatch(/junk|198\.51\.100|2001:db8/);
  } finally { setLogSink(previous); vi.useRealTimers(); }
});
