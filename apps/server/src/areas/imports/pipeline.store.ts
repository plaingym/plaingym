// SPDX-License-Identifier: AGPL-3.0-only
import { t } from './pipeline.messages.js';
import { AppError } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Uploads } from '../../infra/storage/index.js';
export type UploadsFor = (gymId: string) => Promise<Uploads>;
/** TODO(CCR): dedicated run/chunk tables should replace manifests and the import audit checkpoints. */
export class PipelineStore {
  constructor(readonly uploadsFor: UploadsFor) {}
  key(gymId: string, kind: string, id: string, file: string): string { return `${gymId}/imports/${kind}/${id}/${file}`; }
  async put(gymId: string, key: string, value: unknown): Promise<void> {
    assertNoTransaction('imports.store.put');
    await (await this.uploadsFor(gymId)).put(key, new TextEncoder().encode(JSON.stringify(value)), 'application/json');
  }
  async get<T>(gymId: string, key: string): Promise<T> {
    assertNoTransaction('imports.store.get');
    const uploads = await this.uploadsFor(gymId), info = await uploads.head(key);
    const body = info && !info.deletedAt ? await uploads.get(key) : null;
    if (!body) throw new AppError('not_found', t('imports/pipeline:notFound'));
    return await new Response(body).json() as T;
  }
  async exists(gymId: string, key: string): Promise<boolean> {
    assertNoTransaction('imports.store.exists');
    const info = await (await this.uploadsFor(gymId)).head(key); return !!info && !info.deletedAt;
  }
  async putOnce(gymId: string, key: string, value: unknown): Promise<void> {
    if (await this.exists(gymId, key)) return;
    try { await this.put(gymId, key, value); }
    catch (error) { if (!(await this.exists(gymId, key))) throw error; }
  }
  async claim(gymId: string, key: string): Promise<boolean> {
    try { await this.put(gymId, key, {}); return true; }
    catch (error) { if (await this.exists(gymId, key)) return false; throw error; }
  }
}
