// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { Auth } from '../infra/auth/index.js';
import type { Email } from '../infra/email/index.js';
import type { Jobs } from '../infra/jobs/index.js';
import type { Payments, CreateCharge, CheckoutRequest } from '../infra/payments/index.js';
import type { Uploads, BackupObjectStore } from '../infra/storage/index.js';

export function stream(bytes: readonly number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}
export async function readBytes(body: ReadableStream<Uint8Array> | null): Promise<number[]> {
  expect(body).not.toBeNull();
  return [...new Uint8Array(await new Response(body).arrayBuffer())];
}

export function authContract(
  name: string,
  create: () => Promise<{
    auth: Auth;
    authenticated: Request;
    otherGym: Request;
  }>,
) {
  describe(name, () => {
    it('reads identity only and rejects missing and foreign-gym sessions', async () => {
      const { auth, authenticated, otherGym } = await create();
      expect(await auth.getSession(authenticated)).toEqual({ userId: 'user' });
      expect(await auth.getSession(new Request('https://gym.invalid'))).toBeNull();
      expect(await auth.getSession(otherGym)).toBeNull();
    });
  });
}
export function emailContract(name: string, create: () => Promise<Email>) {
  describe(name, () => {
    it('sends text and HTML with a delivery identifier', async () => {
      const email = await create();
      expect(
        await email.sendEmail({
          to: 'member@example.test',
          subject: 'Receipt',
          html: '<p>Receipt</p>',
          text: 'Receipt',
          replyTo: 'owner@example.test',
        }),
      ).toMatchObject({ status: 'sent', messageId: expect.any(String) });
    });
  });
}
export function jobsContract(name: string, create: () => Promise<Jobs>) {
  describe(name, () => {
    it('deduplicates enqueue by gym and job name', async () => {
      const jobs = await create();
      const options = { gymId: 'a', timezone: 'UTC', idempotencyKey: 'period' };
      const first = await jobs.enqueue('charge', { invoice: 1 }, options);
      expect(await jobs.enqueue('charge', { invoice: 1 }, options)).toEqual(first);
      expect(await jobs.enqueue('charge', { invoice: 1 }, { ...options, gymId: 'b' })).not.toEqual(first);
      expect(await jobs.enqueue('email', { invoice: 1 }, options)).not.toEqual(first);
    });
  });
}
export function paymentsContract(
  name: string,
  create: () => Promise<{
    payments: Payments;
    charge: CreateCharge;
    checkout: CheckoutRequest;
  }>,
) {
  describe(name, () => {
    it('creates without moving money, confirms separately, and retrieves by ID', async () => {
      const { payments, charge } = await create();
      const intent = await payments.createCharge(charge);
      expect(await payments.createCharge(charge)).toEqual(intent);
      expect(await payments.findCharge({ kind: 'charge', id: intent.id })).toMatchObject({
        status: 'pending',
      });
      const result = await payments.confirmCharge(intent.id, {
        idempotencyKey: charge.idempotencyKey + ':confirm',
      });
      expect(result).toMatchObject({ status: 'succeeded', amount: charge.amount, currency: charge.currency });
      expect(await payments.findCharge({ kind: 'charge', id: intent.id })).toEqual(result);
      expect(
        await payments.confirmCharge(intent.id, { idempotencyKey: charge.idempotencyKey + ':confirm' }),
      ).toEqual(result);
    });
    it('returns unknown for an unresolved ID and never interprets absence as failure', async () => {
      const { payments } = await create();
      expect(await payments.findCharge({ kind: 'charge', id: 'pi_missing' })).toMatchObject({
        status: 'unknown',
      });
      expect(await payments.findCharge({ kind: 'checkout', id: 'cs_missing' })).toMatchObject({
        status: 'unknown',
      });
    });
    it('expires an open Checkout and tolerates a repeated expiry', async () => {
      const { payments, checkout } = await create();
      const session = await payments.createCheckout(checkout);
      expect(await payments.createCheckout(checkout)).toEqual(session);
      expect(await payments.expireCheckout(session.id)).toEqual({ status: 'expired' });
      expect(await payments.expireCheckout(session.id)).toEqual({ status: 'expired' });
    });
  });
}
export function uploadsContract(name: string, create: () => Promise<Uploads>) {
  describe(name, () => {
    it('keeps immutable bytes, lists metadata, and defers deletion until sweep', async () => {
      const store = await create();
      const source = new Uint8Array([1, 2, 3]);
      const original = await store.put('gym/photo', source, 'image/png');
      source[0] = 9;
      expect(original).toMatchObject({ key: 'gym/photo', size: 3, contentType: 'image/png' });
      expect(await readBytes(await store.get('gym/photo'))).toEqual([1, 2, 3]);
      await expect(store.put('gym/photo', new Uint8Array([4]), 'image/png')).rejects.toThrow();
      expect(await store.head('gym/photo')).toEqual(original);
      expect(await store.list('gym/')).toHaveLength(1);
      expect(await store.signedUrl('gym/photo', 60)).toEqual(expect.any(String));
      await store.markDeleted('gym/photo');
      expect(await readBytes(await store.get('gym/photo'))).toEqual([1, 2, 3]);
      expect(
        await store.sweep({ before: new Date('2100-01-01'), protectedKeys: new Set(['gym/photo']) }),
      ).toEqual([]);
      expect(await store.sweep({ before: new Date('2100-01-01') })).toEqual(['gym/photo']);
      expect(await store.head('gym/photo')).toBeNull();
      expect(await store.get('gym/photo')).toBeNull();
      expect(await store.signedUrl('gym/photo', 60)).toBeNull();
      // A swept key must not be reused by a different upload.
      await expect(store.put('gym/photo', new Uint8Array([4]), 'image/png')).rejects.toThrow();
    });
    it('rejects foreign prefixes and traversal for every key operation', async () => {
      const store = await create();
      for (const key of ['other/photo', 'gym/../other/photo', 'gym/./photo', 'gym/..\\photo']) {
        await expect(store.put(key, new Uint8Array(), 'text/plain')).rejects.toThrow();
        await expect(store.get(key)).rejects.toThrow();
        await expect(store.head(key)).rejects.toThrow();
        await expect(store.markDeleted(key)).rejects.toThrow();
        await expect(store.signedUrl(key, 60)).rejects.toThrow();
        await expect(store.list(key)).rejects.toThrow();
      }
    });
  });
}
export function backupContract(name: string, create: () => Promise<BackupObjectStore>) {
  describe(name, () => {
    it('streams objects, lists by prefix, reads metadata and deletes idempotently', async () => {
      const store = await create();
      const metadata = await store.putObject('snapshots/one', stream([1, 2, 3]), {
        contentType: 'application/test',
      });
      await store.putObject('other/two', stream([4]));
      expect(metadata).toMatchObject({ size: 3, contentType: 'application/test' });
      expect(await store.headObject('snapshots/one')).toEqual(metadata);
      expect(await readBytes(await store.getObject('snapshots/one'))).toEqual([1, 2, 3]);
      expect((await store.listObjects('snapshots/')).map((item) => item.key)).toEqual(['snapshots/one']);
      await store.deleteObject('snapshots/one');
      await store.deleteObject('snapshots/one');
      expect(await store.headObject('snapshots/one')).toBeNull();
      expect(await store.getObject('snapshots/one')).toBeNull();
    });
    it('does not publish an object when its input stream fails', async () => {
      const store = await create();
      let reads = 0;
      const broken = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
          else controller.error(new Error('broken source'));
        },
      });
      await expect(store.putObject('broken', broken)).rejects.toThrow('broken source');
      expect(await store.headObject('broken')).toBeNull();
    });
    it('aborts a pending read without publishing an object', async () => {
      const store = await create();
      const controller = new AbortController();
      const pending = store.putObject('aborted', new ReadableStream<Uint8Array>(), {
        signal: controller.signal,
      });
      controller.abort(new Error('canceled'));
      await expect(pending).rejects.toThrow('canceled');
      expect(await store.headObject('aborted')).toBeNull();
    });
  });
}
