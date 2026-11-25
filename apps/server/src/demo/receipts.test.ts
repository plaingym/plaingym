// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { FakeUploads } from '../infra/storage/index.js';
import { DemoUploads, demoReceiptCountMs, demoReceiptCountSize, demoReceiptReuseLimit, demoReceiptReuseSize } from './uploads.js';
import { TestClock } from '../core/clock.js';

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
async function fillReceipts(gymId: string, uploads: DemoUploads, render: () => Promise<Uint8Array>, count = receiptLimit) {
  const invoiceId = uuidv7(), freshKey = () => `${gymId}/receipts/${invoiceId}/${uuidv7()}.pdf`;
  const keys = Array.from({ length: count }, (_, index) => receiptKey(gymId, invoiceId, index));
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

async function overflowFixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-01-01T00:00:00.000Z');
  const source = new FakeUploads(gymId, clock), uploads = new DemoUploads(source, () => clock.now().getTime());
  const render = vi.fn(async () => receiptBytes);
  const { invoiceId, freshKey } = await fillReceipts(gymId, uploads, render);
  render.mockClear();
  return { gymId, clock, source, uploads, render, invoiceId, freshKey };
}
function deletedCopies(source: FakeUploads, gymId: string, invoiceId: string) {
  return source.list(`${gymId}/receipts/${invoiceId}/`).then(list => list.filter(info => info.deletedAt));
}

it('reuses an over-limit receipt copy for five minutes and renders again at the boundary', async () => {
  const { gymId, clock, source, uploads, render, invoiceId, freshKey } = await overflowFixture();
  const overflow = receiptKey(gymId, invoiceId, receiptLimit);
  const first = await uploads.receiptPdf(overflow, render, freshKey);
  expect(first).not.toBe(overflow);
  expect(first.slice(0, first.lastIndexOf('/'))).toBe(overflow.slice(0, overflow.lastIndexOf('/')));
  expect((await source.head(first))?.deletedAt).toBeDefined();
  expect(await deletedCopies(source, gymId, invoiceId)).toHaveLength(1);
  clock.advance(299_999);
  expect(await uploads.receiptPdf(overflow, render, freshKey)).toBe(first);
  expect(render).toHaveBeenCalledOnce();
  expect(await deletedCopies(source, gymId, invoiceId)).toHaveLength(1);
  clock.advance(1);
  const second = await uploads.receiptPdf(overflow, render, freshKey);
  expect(second).not.toBe(first);
  expect(render).toHaveBeenCalledTimes(2);
  expect(await deletedCopies(source, gymId, invoiceId)).toHaveLength(2);
});

it('keeps a separate over-limit copy for each receipt content', async () => {
  const { gymId, source, uploads, render, invoiceId, freshKey } = await overflowFixture();
  const firstKey = receiptKey(gymId, invoiceId, receiptLimit), secondKey = receiptKey(gymId, invoiceId, receiptLimit + 1);
  const first = await uploads.receiptPdf(firstKey, render, freshKey);
  const second = await uploads.receiptPdf(secondKey, render, freshKey);
  expect(first).not.toBe(second);
  expect(await uploads.receiptPdf(firstKey, render, freshKey)).toBe(first);
  expect(await uploads.receiptPdf(secondKey, render, freshKey)).toBe(second);
  expect(render).toHaveBeenCalledTimes(2);
  for (const key of [first, second]) {
    expect(key.slice(0, key.lastIndexOf('/'))).toBe(firstKey.slice(0, firstKey.lastIndexOf('/')));
    expect((await source.head(key))?.deletedAt).toBeDefined();
  }
});

it('renders a new over-limit copy after the reused copy is swept', async () => {
  const { gymId, clock, source, uploads, render, invoiceId, freshKey } = await overflowFixture();
  const overflow = receiptKey(gymId, invoiceId, receiptLimit);
  const first = await uploads.receiptPdf(overflow, render, freshKey);
  clock.advance(1_000);
  expect(await uploads.receiptPdf(overflow, render, freshKey)).toBe(first);
  expect(render).toHaveBeenCalledOnce();
  expect(await source.sweep({ before: clock.now() })).toEqual([first]);
  const second = await uploads.receiptPdf(overflow, render, freshKey);
  expect(second).not.toBe(first);
  expect(render).toHaveBeenCalledTimes(2);
  expect((await source.head(second))?.deletedAt).toBeDefined();
});

it('counts only digest-named copies toward the sandbox limit', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-01-01T00:00:00.000Z');
  const source = new FakeUploads(gymId, clock), uploads = new DemoUploads(source, () => clock.now().getTime());
  const render = vi.fn(async () => receiptBytes);
  const { invoiceId, freshKey } = await fillReceipts(gymId, uploads, render, receiptLimit - 1);
  const leftover = `${gymId}/receipts/${invoiceId}/${uuidv7()}.pdf`;
  await source.put(leftover, receiptBytes, 'application/pdf');
  const key = receiptKey(gymId, invoiceId, receiptLimit - 1);
  expect(await uploads.receiptPdf(key, render, freshKey)).toBe(key);
  const live = (await source.list(`${gymId}/receipts/`)).filter(info => !info.deletedAt);
  expect(live.filter(info => /\/[0-9a-f]{64}\.pdf$/.test(info.key))).toHaveLength(receiptLimit);
  expect(live).toHaveLength(receiptLimit + 1);
});

it('bounds the over-limit reuse map', async () => {
  const { gymId, uploads, render, invoiceId, freshKey } = await overflowFixture();
  for (let index = 0; index < demoReceiptReuseLimit + 1; index++)
    await uploads.receiptPdf(receiptKey(gymId, invoiceId, receiptLimit + index), render, freshKey);
  expect(demoReceiptReuseSize()).toBe(demoReceiptReuseLimit);
});

it('coalesces concurrent over-limit downloads and reuses the result', async () => {
  const { gymId, uploads, render, invoiceId, freshKey } = await overflowFixture();
  const overflow = receiptKey(gymId, invoiceId, receiptLimit);
  const [first, second] = await Promise.all([
    uploads.receiptPdf(overflow, render, freshKey),
    uploads.receiptPdf(overflow, render, freshKey),
  ]);
  expect(first).toBe(second);
  expect(render).toHaveBeenCalledOnce();
  expect(await uploads.receiptPdf(overflow, render, freshKey)).toBe(first);
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

it('lists a sandbox receipts prefix once per ten minutes while counting new durable puts', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-01-01T00:00:00.000Z');
  const source = new FakeUploads(gymId, clock), listSpy = vi.spyOn(source, 'list');
  const uploads = new DemoUploads(source, () => clock.now().getTime());
  const invoiceId = uuidv7(), freshKey = () => `${gymId}/receipts/${invoiceId}/${uuidv7()}.pdf`;
  const render = async () => receiptBytes;
  for (let index = 0; index < 10; index++) {
    const key = receiptKey(gymId, invoiceId, index);
    expect(await uploads.receiptPdf(key, render, freshKey)).toBe(key);
  }
  expect(listSpy).toHaveBeenCalledTimes(1);
  expect(listSpy).toHaveBeenCalledWith(`${gymId}/receipts/`);
  clock.advance(demoReceiptCountMs - 1);
  const stillCached = receiptKey(gymId, invoiceId, 10);
  expect(await uploads.receiptPdf(stillCached, render, freshKey)).toBe(stillCached);
  expect(listSpy).toHaveBeenCalledTimes(1);
  clock.advance(1);
  const refreshed = receiptKey(gymId, invoiceId, 11);
  expect(await uploads.receiptPdf(refreshed, render, freshKey)).toBe(refreshed);
  expect(listSpy).toHaveBeenCalledTimes(2);
});

it('counts seeded digest copies once and serves the 65th as deleted without listing again', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-01-01T00:00:00.000Z');
  const source = new FakeUploads(gymId, clock), uploads = new DemoUploads(source, () => clock.now().getTime());
  const invoiceId = uuidv7(), freshKey = () => `${gymId}/receipts/${invoiceId}/${uuidv7()}.pdf`;
  const render = async () => receiptBytes;
  for (let index = 0; index < receiptLimit - 1; index++)
    await source.put(receiptKey(gymId, invoiceId, index), receiptBytes, 'application/pdf');
  const listSpy = vi.spyOn(source, 'list');
  const lastDurable = receiptKey(gymId, invoiceId, receiptLimit - 1);
  expect(await uploads.receiptPdf(lastDurable, render, freshKey)).toBe(lastDurable);
  expect(await source.head(lastDurable)).not.toBeNull();
  const overflow = receiptKey(gymId, invoiceId, receiptLimit);
  const ephemeral = await uploads.receiptPdf(overflow, render, freshKey);
  expect(ephemeral).not.toBe(overflow);
  expect((await source.head(ephemeral))?.deletedAt).toBeDefined();
  expect(listSpy).toHaveBeenCalledTimes(1);
});

it('keeps counting stored copies when a slower listing for the same sandbox finishes last', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const invoiceId = uuidv7(), freshKey = () => `${gymId}/receipts/${invoiceId}/${uuidv7()}.pdf`;
  const render = async () => receiptBytes;
  for (let index = 0; index < receiptLimit - 2; index++)
    await source.put(receiptKey(gymId, invoiceId, index), receiptBytes, 'application/pdf');
  const list = source.list.bind(source);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(source, 'list').mockImplementationOnce(list)
    .mockImplementationOnce(async prefix => { const found = await list(prefix); await held; return found; });
  const first = uploads.receiptPdf(receiptKey(gymId, invoiceId, receiptLimit - 2), render, freshKey);
  const second = uploads.receiptPdf(receiptKey(gymId, invoiceId, receiptLimit - 1), render, freshKey);
  await first;
  release();
  await second;
  const overflow = receiptKey(gymId, invoiceId, receiptLimit);
  expect(await uploads.receiptPdf(overflow, render, freshKey)).not.toBe(overflow);
});

it('counts a copy whose put failed after storing it', async () => {
  const gymId = uuidv7(), source = new FakeUploads(gymId), uploads = new DemoUploads(source);
  const invoiceId = uuidv7(), freshKey = () => `${gymId}/receipts/${invoiceId}/${uuidv7()}.pdf`;
  const render = async () => receiptBytes;
  for (let index = 0; index < receiptLimit - 1; index++)
    await source.put(receiptKey(gymId, invoiceId, index), receiptBytes, 'application/pdf');
  const put = source.put.bind(source);
  vi.spyOn(source, 'put').mockImplementationOnce(async (...args) => { await put(...args); throw new Error('response lost'); });
  const stored = receiptKey(gymId, invoiceId, receiptLimit - 1);
  expect(await uploads.receiptPdf(stored, render, freshKey)).toBe(stored);
  const overflow = receiptKey(gymId, invoiceId, receiptLimit);
  expect(await uploads.receiptPdf(overflow, render, freshKey)).not.toBe(overflow);
});

it('keeps separate per-sandbox counts and drops the oldest entry above 1,000 gyms', async () => {
  const clock = new TestClock('2026-01-01T00:00:00.000Z');
  const render = async () => receiptBytes;
  const gymA = uuidv7(), sourceA = new FakeUploads(gymA, clock), uploadsA = new DemoUploads(sourceA, () => clock.now().getTime());
  const gymB = uuidv7(), sourceB = new FakeUploads(gymB, clock), uploadsB = new DemoUploads(sourceB, () => clock.now().getTime());
  await fillReceipts(gymA, uploadsA, render);
  const invA = uuidv7(), invB = uuidv7();
  const overflowA = receiptKey(gymA, invA, receiptLimit);
  expect(await uploadsA.receiptPdf(overflowA, render, () => `${gymA}/receipts/${invA}/${uuidv7()}.pdf`)).not.toBe(overflowA);
  const durableB = receiptKey(gymB, invB, 0);
  expect(await uploadsB.receiptPdf(durableB, render, () => `${gymB}/receipts/${invB}/${uuidv7()}.pdf`)).toBe(durableB);

  const tracked: Array<{ gymId: string; source: FakeUploads; uploads: DemoUploads; invoiceId: string }> = [];
  for (let index = 0; index < 1_000; index++) {
    const gymId = uuidv7(), source = new FakeUploads(gymId, clock), uploads = new DemoUploads(source, () => clock.now().getTime());
    const invoiceId = uuidv7();
    await uploads.receiptPdf(receiptKey(gymId, invoiceId, 0), render, () => `${gymId}/receipts/${invoiceId}/${uuidv7()}.pdf`);
    tracked.push({ gymId, source, uploads, invoiceId });
  }
  expect(demoReceiptCountSize()).toBe(1_000);
  const newestGym = uuidv7(), newestSource = new FakeUploads(newestGym, clock), newestUploads = new DemoUploads(newestSource, () => clock.now().getTime());
  const newestInvoice = uuidv7();
  await newestUploads.receiptPdf(receiptKey(newestGym, newestInvoice, 0), render, () => `${newestGym}/receipts/${newestInvoice}/${uuidv7()}.pdf`);
  expect(demoReceiptCountSize()).toBe(1_000);

  const newestListSpy = vi.spyOn(newestSource, 'list');
  await newestUploads.receiptPdf(receiptKey(newestGym, newestInvoice, 1), render, () => `${newestGym}/receipts/${newestInvoice}/${uuidv7()}.pdf`);
  expect(newestListSpy).not.toHaveBeenCalled();

  const oldest = tracked[0]!;
  const oldestListSpy = vi.spyOn(oldest.source, 'list');
  await oldest.uploads.receiptPdf(receiptKey(oldest.gymId, oldest.invoiceId, 1), render, () => `${oldest.gymId}/receipts/${oldest.invoiceId}/${uuidv7()}.pdf`);
  expect(oldestListSpy).toHaveBeenCalledTimes(1);
});
