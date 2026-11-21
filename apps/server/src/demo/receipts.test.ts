// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { FakeUploads } from '../infra/storage/index.js';
import { DemoUploads } from './uploads.js';

it('coalesces generated receipts and refuses oversized, non-PDF or misplaced writes', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const key = `${gymId}/receipts/${uuidv7()}/${'a'.repeat(64)}.pdf`;
  const fallback = () => key.replace(/[^/]+$/, `${uuidv7()}.pdf`);
  const render = vi.fn(async () => new TextEncoder().encode('%PDF-1.7 generated receipt'));
  expect(await Promise.all([uploads.receiptPdf(key, render, fallback), uploads.receiptPdf(key, render, fallback)])).toEqual([key, key]);
  expect(await uploads.receiptPdf(key, render, fallback)).toBe(key);
  expect(render).toHaveBeenCalledOnce();
  expect(await source.list()).toHaveLength(1);
  const freshKey = () => `${gymId}/receipts/${uuidv7()}/${'b'.repeat(64)}.pdf`;
  await expect(uploads.receiptPdf(freshKey(), async () => new Uint8Array(1024 * 1024 + 1), fallback)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(uploads.receiptPdf(freshKey(), async () => new Uint8Array([1]), fallback)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(uploads.receiptPdf(`${gymId}/photo.png`, render, fallback)).rejects.toMatchObject({ code: 'not_found' });
  await expect(uploads.receiptPdf(`${uuidv7()}/receipts/${uuidv7()}/${'c'.repeat(64)}.pdf`, render, fallback)).rejects.toThrow('another gym');
  expect(await source.list()).toHaveLength(1);
  await uploads.markDeleted(key);
  await expect(uploads.receiptPdf(key, render, fallback)).rejects.toMatchObject({ code: 'not_found' });
});

const receiptLimit = 64;
const receiptBytes = new TextEncoder().encode('%PDF-1.7 generated receipt');
function receiptKey(gymId: string, invoiceId: string, seed: number): string {
  return `${gymId}/receipts/${invoiceId}/${seed.toString(16).padStart(64, '0')}.pdf`;
}
async function fillReceipts(gymId: string, uploads: DemoUploads, render: () => Promise<Uint8Array>) {
  const invoiceId = uuidv7(), freshKey = () => `${gymId}/receipts/${invoiceId}/${uuidv7()}.pdf`;
  const keys = Array.from({ length: receiptLimit }, (_, index) => receiptKey(gymId, invoiceId, index));
  for (const key of keys) expect(await uploads.receiptPdf(key, render, freshKey)).toBe(key);
  return { invoiceId, freshKey, keys };
}

it('keeps one cached copy for each receipt content up to the sandbox limit', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const render = vi.fn(async () => receiptBytes);
  const { keys } = await fillReceipts(gymId, uploads, render);
  expect(keys).toHaveLength(receiptLimit);
  const stored = await source.list(`${gymId}/receipts/`);
  expect(stored).toHaveLength(receiptLimit);
  expect(stored.filter(info => info.deletedAt)).toHaveLength(0);
});

it('serves a swept copy beyond the sandbox limit instead of caching another', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const render = vi.fn(async () => receiptBytes);
  const { invoiceId, freshKey } = await fillReceipts(gymId, uploads, render);
  const overflow = receiptKey(gymId, invoiceId, receiptLimit);
  const ephemeral = await uploads.receiptPdf(overflow, render, freshKey);
  expect(ephemeral).not.toBe(overflow);
  expect(ephemeral.slice(0, ephemeral.lastIndexOf('/'))).toBe(overflow.slice(0, overflow.lastIndexOf('/')));
  expect(ephemeral).toMatch(/^[0-9a-f-]{36}\/receipts\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/);
  expect((await source.head(ephemeral))?.deletedAt).toBeDefined();
  expect(await source.head(overflow)).toBeNull();
  expect((await source.list(`${gymId}/receipts/`)).filter(info => !info.deletedAt)).toHaveLength(receiptLimit);
  expect(await uploads.signedUrl(ephemeral, 300)).not.toBeNull();
});

it('keeps serving a cached copy once the sandbox limit is reached', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const render = vi.fn(async () => receiptBytes);
  const { invoiceId, freshKey, keys } = await fillReceipts(gymId, uploads, render);
  await uploads.receiptPdf(receiptKey(gymId, invoiceId, receiptLimit), render, freshKey);
  render.mockClear();
  expect(await uploads.receiptPdf(keys[0]!, render, freshKey)).toBe(keys[0]);
  expect(render).not.toHaveBeenCalled();
});

it('accepts a new cached copy after a deleted one frees a slot', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const render = vi.fn(async () => receiptBytes);
  const { invoiceId, freshKey, keys } = await fillReceipts(gymId, uploads, render);
  await uploads.receiptPdf(receiptKey(gymId, invoiceId, receiptLimit), render, freshKey);
  await uploads.markDeleted(keys[0]!);
  const replacement = receiptKey(gymId, invoiceId, receiptLimit + 1);
  expect(await uploads.receiptPdf(replacement, render, freshKey)).toBe(replacement);
  expect(await source.head(replacement)).not.toBeNull();
  expect((await source.list(`${gymId}/receipts/`)).filter(info => !info.deletedAt)).toHaveLength(receiptLimit);
});

it('coalesces concurrent over-limit receipts onto one swept copy', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const render = vi.fn(async () => receiptBytes);
  const { invoiceId, freshKey } = await fillReceipts(gymId, uploads, render);
  render.mockClear();
  const overflow = receiptKey(gymId, invoiceId, receiptLimit);
  const [first, second] = await Promise.all([
    uploads.receiptPdf(overflow, render, freshKey),
    uploads.receiptPdf(overflow, render, freshKey),
  ]);
  expect(first).toBe(second);
  expect(first).not.toBe(overflow);
  expect((await source.head(first))?.deletedAt).toBeDefined();
  expect(render).toHaveBeenCalledOnce();
});

it('recovers a failed immutable reservation with an ephemeral copy and recognizes another writer winning', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const prefix = `${gymId}/receipts/${uuidv7()}/`, key = prefix + 'a'.repeat(64) + '.pdf';
  const bytes = new TextEncoder().encode('%PDF-1.7 generated receipt'), render = async () => bytes;
  const put = source.put.bind(source), spy = vi.spyOn(source, 'put');
  spy.mockRejectedValueOnce(new Error('Upload keys are immutable'));
  const fallback = await uploads.receiptPdf(key, render, () => prefix + uuidv7() + '.pdf');
  expect(fallback).not.toBe(key);
  expect((await source.head(fallback))?.deletedAt).toBeDefined();
  spy.mockImplementationOnce(async (...args) => { await put(...args); throw new Error('Storage response lost'); });
  expect(await uploads.receiptPdf(key, render, () => prefix + uuidv7() + '.pdf')).toBe(key);
  expect(await source.list()).toHaveLength(2);
});
