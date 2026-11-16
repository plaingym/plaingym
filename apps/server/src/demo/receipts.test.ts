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
