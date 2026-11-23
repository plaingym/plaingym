// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { ReadOptions, UploadInfo, Uploads } from '../infra/storage/index.js';
import { validateSignatureImage } from '../areas/waivers/snapshot.js';
import { parseSignatureImageKey } from '../areas/waivers/signature-image-key.js';

const t = createTranslator(locales.en ?? {});

export const demoReceiptCopyLimit = 64;
export const demoReceiptReuseMs = 300_000;
export const demoReceiptReuseLimit = 1_000;
const overLimitCopies = new Map<string, { key: string; until: number }>();
export function demoReceiptReuseSize(): number { return overLimitCopies.size; }

const pending = new Map<string, Promise<string>>();
function pdfKey(key: string): string | undefined {
  const match = parseSignatureImageKey(key);
  return match ? `${match.gymId}/waivers/${match.memberId}/pdf/${match.imageId}.pdf` : undefined;
}

/** Narrow waiver and receipt operations; the shared Uploads interface refuses general visitor puts. */
export class DemoUploads implements Uploads {
  constructor(private readonly source: Uploads, private readonly now: () => number = () => Date.now()) {}
  async put(): ReturnType<Uploads['put']> {
    assertNoTransaction('storage.put');
    throw new AppError('forbidden', t('demo/demo:uploadsDisabled'));
  }
  /** The waiver service authorizes the member and reserves a persistent demo admission first. */
  async waiverSignature(key: string, bytes: Uint8Array): ReturnType<Uploads['put']> {
    assertNoTransaction('storage.put');
    if (!parseSignatureImageKey(key)) throw new AppError('not_found', 'Resource not found');
    validateSignatureImage(bytes);
    return this.source.put(key, bytes, 'image/png');
  }
  /** Called only after household invoice authorization, with a digest of the server-generated receipt. */
  async receiptPdf(key: string, render: () => Promise<Uint8Array>, freshKey: () => string): Promise<string> {
    assertNoTransaction('storage.put');
    if (!/^[0-9a-f-]{36}\/receipts\/[0-9a-f-]{36}\/[0-9a-f]{64}\.pdf$/.test(key))
      throw new AppError('not_found', 'Resource not found');
    return this.#cachedPdf(key, {
      cached: info => !info.deletedAt && info.contentType === 'application/pdf',
      render: async () => {
        const bytes = await render();
        if (bytes.length > 1024 * 1024 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
          throw new AppError('unavailable', 'Receipt is not available');
        return bytes;
      },
      fallbackKey: () => {
        const fallback = freshKey();
        if (!/^[0-9a-f-]{36}\/receipts\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/.test(fallback)
          || fallback.slice(0, fallback.lastIndexOf('/')) !== key.slice(0, key.lastIndexOf('/')))
          throw new AppError('not_found', 'Resource not found');
        return fallback;
      },
      rethrowUnusableWinner: true,
      full: async () => (await this.source.list(key.slice(0, 36) + '/receipts/')).filter(info => !info.deletedAt && /\/[0-9a-f]{64}\.pdf$/.test(info.key)).length >= demoReceiptCopyLimit,
    });
  }
  async #cachedPdf(key: string, o: {
    cached(info: UploadInfo): boolean;
    render(): Promise<Uint8Array>;
    fallbackKey(): string;
    rethrowUnusableWinner: boolean;
    full?(): Promise<boolean>;
  }): Promise<string> {
    let work = pending.get(key);
    if (!work) {
      work = (async () => {
        const cached = await this.source.head(key);
        if (cached) {
          if (o.cached(cached)) return key;
          throw new AppError('not_found', 'Resource not found');
        }
        if (o.full) {
          const reusable = overLimitCopies.get(key);
          if (reusable) {
            if (reusable.until > this.now()) {
              const copy = await this.source.head(reusable.key);
              if (copy?.contentType === 'application/pdf') return reusable.key;
            }
            overLimitCopies.delete(key);
          }
        }
        const bytes = await o.render();
        if (o.full && await o.full()) {
          const fallback = await this.#ephemeral(o.fallbackKey(), bytes);
          if (overLimitCopies.size >= demoReceiptReuseLimit && !overLimitCopies.has(key)) {
            const oldest = overLimitCopies.keys().next().value;
            if (oldest !== undefined) overLimitCopies.delete(oldest);
          }
          overLimitCopies.set(key, { key: fallback, until: this.now() + demoReceiptReuseMs });
          return fallback;
        }
        try { await this.source.put(key, bytes, 'application/pdf'); }
        catch (error) {
          const winner = await this.source.head(key);
          if (winner && !winner.deletedAt && winner.contentType === 'application/pdf') return key;
          if (winner && o.rethrowUnusableWinner) throw error;
          // A failed durable reservation never releases its key. Serve a swept copy, like waiver PDFs.
          return await this.#ephemeral(o.fallbackKey(), bytes);
        }
        return key;
      })();
      pending.set(key, work);
    }
    try { return await work; }
    finally { if (pending.get(key) === work) pending.delete(key); }
  }
  async #ephemeral(fallback: string, bytes: Uint8Array): Promise<string> {
    await this.source.put(fallback, bytes, 'application/pdf');
    await this.source.markDeleted(fallback);
    return fallback;
  }
  get: Uploads['get'] = (key, options) => this.source.get(key, options);
  head: Uploads['head'] = (key, options) => this.source.head(key, options);
  list: Uploads['list'] = prefix => this.source.list(prefix);
  signedUrl: Uploads['signedUrl'] = (key, ttl) => this.source.signedUrl(key, ttl);
  sweep: Uploads['sweep'] = options => this.source.sweep(options);
  async markDeleted(key: string, options?: ReadOptions): Promise<void> {
    await this.source.markDeleted(key, options);
    // Member erasure already deletes signature images through this wrapper.
    const cached = pdfKey(key);
    // Once the signature is marked, complete its paired erasure even if the caller disconnects.
    if (cached) await this.source.markDeleted(cached);
  }
  async waiverPdf(signatureImageKey: string, render: () => Promise<Uint8Array>, freshKey: () => string): Promise<string> {
    assertNoTransaction('storage.put');
    const key = pdfKey(signatureImageKey);
    if (!key) throw new AppError('not_found', 'Resource not found');
    return this.#cachedPdf(key, {
      cached: info => !info.deletedAt,
      render: async () => {
        const bytes = await render(), image = await this.source.head(signatureImageKey);
        if (!image || image.deletedAt) throw new AppError('not_found', 'Resource not found');
        return bytes;
      },
      fallbackKey: freshKey,
      rethrowUnusableWinner: false,
    });
  }
}

/** Wrap every sandbox's upload provider before handing it to any feature. */
export function demoUploads(readonlyUploads: Uploads): Uploads { return new DemoUploads(readonlyUploads); }
