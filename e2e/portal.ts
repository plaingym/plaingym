// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { Client, expect } from './support.js';

export const demoInstall = 'https://demo.localhost';
export const stripeOrigin = 'https://stripe.localhost';
interface OutboxMessage { id: string; recipient: string; subject: string; text: string; sentAt: string }

function secret(name: 'E2E_STRIPE_KEY' | 'E2E_STRIPE_WEBHOOK_SECRET') {
  const value = process.env[name];
  if (!value) throw new Error('Run through pnpm --dir e2e test to configure the fake Stripe');
  return value;
}
/** The fake Stripe API (stripe/server.mjs), read with the demo install's own test key. */
export const fakeStripe = () => new Client(stripeOrigin, { authorization: 'Bearer ' + secret('E2E_STRIPE_KEY') });

/** Sends a signed event to the install's one webhook endpoint, which routes it to its sandbox as Stripe's delivery would. */
export async function deliverStripeEvent(type: string, object: Record<string, unknown>) {
  const created = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: 'evt_' + randomBytes(12).toString('hex'), object: 'event', api_version: '2026-09-30.endive',
    created, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object } });
  const signature = createHmac('sha256', secret('E2E_STRIPE_WEBHOOK_SECRET')).update(`${created}.${body}`).digest('hex');
  const response = await new Client(demoInstall).request('/webhooks/stripe', 'POST', Buffer.from(body), { 'stripe-signature': `t=${created},v1=${signature}` });
  expect(response.status, `${type}: ${response.text}`).toBe(200);
}

/** The newest link to `recipient` in the sandbox outbox whose path matches, once it arrives. Outbox links are bearer credentials. */
export async function outboxLink(owner: Client, recipient: string, path: RegExp, after = new Set<string>()) {
  let link: URL | undefined;
  await expect.poll(async () => {
    const outbox = await owner.request<{ data: OutboxMessage[] }>('/api/demo/outbox?limit=100');
    if (outbox.status !== 200) return false;
    const messages = outbox.body.data.filter(message => message.recipient === recipient && !after.has(message.id))
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
    for (const message of messages) for (const match of message.text.matchAll(/https:\/\/[^\s<>"]+/g)) {
      const url = new URL(match[0]);
      if (url.origin === owner.origin && path.test(url.pathname)) { link = url; return true; }
    }
    return false;
  }, { timeout: 30_000, message: 'A link reaches the sandbox outbox' }).toBe(true);
  return link!;
}
export async function outboxIds(owner: Client) {
  return new Set((await owner.json<{ data: OutboxMessage[] }>('/api/demo/outbox?limit=100')).data.map(message => message.id));
}

/** Every request of a run reaches the app from Caddy's one address, so sign-ins share one limiter window; a refused
 * attempt consumes nothing, so wait for the next window. */
export async function retryLimited<T extends { status: number; retryAfter?: number }>(attempt: () => Promise<T>) {
  let result = await attempt();
  for (let tries = 0; result.status === 429 && tries < 3; tries++) {
    // The limiter says how long its window has left; without a hint, wait out a whole minute's window.
    await new Promise(resolve => setTimeout(resolve, (Math.min(result.retryAfter ?? 60, 60) + 1) * 1000));
    result = await attempt();
  }
  return result;
}

/** Follows an emailed portal sign-in link and completes its claim, returning the household's session. */
export async function claimPortal(origin: string, link: URL) {
  const client = new Client(origin), verified = await retryLimited(() => client.request(link.pathname + link.search));
  expect([302, 303], verified.text).toContain(verified.status);
  const callback = new URL(verified.location!, origin);
  expect(callback.pathname).toBe('/portal/claim');
  client.cookie = verified.cookies.map(value => value.split(';')[0]).join('; ');
  await client.json('/api/portal/claims/complete', 'POST', { claim: callback.searchParams.get('claim') });
  return client;
}

/** A small RGB PNG with one drawn stroke, within the waiver signature bounds. */
export function signaturePng(width = 600, height = 200) {
  const stride = 1 + width * 3, raw = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) if (Math.abs(y - (x * height) / width) < 4) raw.fill(0, y * stride + 1 + x * 3, y * stride + 4 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), length = Buffer.alloc(4), check = Buffer.alloc(4);
    length.writeUInt32BE(data.length); check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
