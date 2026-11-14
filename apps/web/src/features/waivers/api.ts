// SPDX-License-Identifier: AGPL-3.0-only
import { waiverContracts, waiverDocumentResponseSchema } from '@plaingym/shared/contracts';
import { billingRequest } from '../billing/catalog/api.js';
import { readApiError } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
export class WaiverRequestError extends Error {}
export function createWaiversClient(fetcher: typeof fetch = fetch) {
  const transport: typeof fetch = async (url, init) => {
    const response = await fetcher(url, init);
    if (response.status === 409 || response.status === 403 || response.status === 429 || (response.status === 400 && String(url).startsWith('/api/waivers/template'))) {
      const { message } = await readApiError(response, [
        { status: 400, code: 'invalid_request' }, { status: 409, code: 'conflict' }, { status: 429, code: 'rate_limited' },
        { status: 403, code: 'forbidden', message: t('demo/demo:uploadsDisabled') },
      ]);
      if (message) throw new WaiverRequestError(message);
    }
    return response;
  };
  return { uploadDocument: async (file: File) => {
    const response = await transport(waiverContracts.uploadDocument.path, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
    if (!response.ok) throw new Error('Document upload failed');
    return waiverDocumentResponseSchema.parse(await response.json());
  }, call: <K extends keyof typeof waiverContracts>(name: K, input?: unknown, params: Record<string, string> = {}, query: Record<string, string | number> = {}) =>
    billingRequest(waiverContracts[name], input, params, query, transport) as Promise<ReturnType<typeof waiverContracts[K]['response']['parse']>> };
}
export const waiversClient = createWaiversClient();
export type WaiversClient = ReturnType<typeof createWaiversClient>;
