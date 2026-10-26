// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Uploads } from '../infra/storage/index.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const imageKey = new RegExp(`^(${uuid}/waivers/${uuid})/signatures/(${uuid})\\.png$`);
const pending = new Map<string, Promise<string>>();
function pdfKey(key: string): string | undefined {
  const match = imageKey.exec(key);
  return match ? `${match[1]}/pdf/${match[2]}.pdf` : undefined;
}

/** Demo-only cache; the shared Uploads interface continues to refuse all visitor puts. */
export class DemoUploads implements Uploads {
  constructor(private readonly source: Uploads) {}
  async put(): ReturnType<Uploads['put']> {
    assertNoTransaction('storage.put');
    throw new AppError('forbidden', 'Uploads are disabled in the demo');
  }
  get: Uploads['get'] = key => this.source.get(key);
  head: Uploads['head'] = key => this.source.head(key);
  list: Uploads['list'] = prefix => this.source.list(prefix);
  signedUrl: Uploads['signedUrl'] = (key, ttl) => this.source.signedUrl(key, ttl);
  sweep: Uploads['sweep'] = options => this.source.sweep(options);
  async markDeleted(key: string): Promise<void> {
    await this.source.markDeleted(key);
    // Member erasure already deletes signature images through this wrapper.
    const cached = pdfKey(key);
    if (cached) await this.source.markDeleted(cached);
  }
  async waiverPdf(signatureImageKey: string, render: () => Promise<Uint8Array>, freshKey: () => string): Promise<string> {
    assertNoTransaction('storage.put');
    const key = pdfKey(signatureImageKey);
    if (!key) throw new AppError('not_found', 'Resource not found');
    let work = pending.get(key);
    if (!work) {
      work = (async () => {
        const cached = await this.source.head(key);
        if (cached) {
          if (cached.deletedAt) throw new AppError('not_found', 'Resource not found');
          return key;
        }
        const bytes = await render(), image = await this.source.head(signatureImageKey);
        if (!image || image.deletedAt) throw new AppError('not_found', 'Resource not found');
        try { await this.source.put(key, bytes, 'application/pdf'); }
        catch {
          // Another process may have published the same immutable copy first.
          const winner = await this.source.head(key);
          if (winner && !winner.deletedAt && winner.contentType === 'application/pdf') return key;
          // A failed upload can leave an immutable reservation without stored bytes.
          const fallback = freshKey();
          await this.source.put(fallback, bytes, 'application/pdf');
          await this.source.markDeleted(fallback);
          return fallback;
        }
        return key;
      })();
      pending.set(key, work);
    }
    try { return await work; }
    finally { if (pending.get(key) === work) pending.delete(key); }
  }
}

/** Wrap every sandbox's upload provider before handing it to any feature. */
export function demoUploads(readonlyUploads: Uploads): Uploads { return new DemoUploads(readonlyUploads); }
