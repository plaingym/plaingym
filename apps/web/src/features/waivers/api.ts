// SPDX-License-Identifier: AGPL-3.0-only
import { waiverContracts, waiverDocumentResponseSchema } from '@plaingym/shared/contracts';
import { billingRequest } from '../billing/catalog/api.js';
export class WaiverRequestError extends Error {}
export function createWaiversClient(fetcher: typeof fetch = fetch) {
  const transport: typeof fetch = async (url, init) => {
    const response = await fetcher(url, init);
    if (response.status === 409 || response.status === 403 || response.status === 429 || (response.status === 400 && String(url).startsWith('/api/waivers/template'))) {
      const body: unknown = await response.clone().json().catch(() => null);
      const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
      if (error && typeof error === 'object' && 'code' in error && 'message' in error
        && typeof error.message === 'string' && error.message.length > 0 && error.message.length <= 2000
        && ((response.status === 400 && error.code === 'invalid_request') || (response.status === 409 && error.code === 'conflict')
          // A full PDF queue says to retry shortly; a rate limit or demo quota says what was refused.
          || (response.status === 429 && error.code === 'rate_limited')
          || (response.status === 403 && error.code === 'forbidden' && error.message === 'Uploads are disabled in the demo'))) {
        throw new WaiverRequestError(error.message);
      }
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
