// SPDX-License-Identifier: AGPL-3.0-only
import { accountContracts, requestEmailChangeSchema, type AccountSummary } from '@plaingym/shared/contracts';
import { parseResponse } from '../../lib/response.js';

/** A refused account request, with the API's error code and field details when it sent them. */
export class AccountRequestError extends Error {
  constructor(readonly status: number, readonly code?: string, readonly details?: Readonly<Record<string, readonly string[]>>) { super('Account request failed'); }
}
async function failure(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { code?: string; details?: Record<string, string[]> } } | null;
  return new AccountRequestError(response.status, body?.error?.code, body?.error?.details);
}
export function createAccountClient(fetcher: typeof fetch = (...args) => fetch(...args)) {
  return {
    async summary(): Promise<AccountSummary> {
      const response = await fetcher(accountContracts.get.path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!response.ok) throw await failure(response);
      return parseResponse(accountContracts.get.response, await response.json()).data;
    },
    async requestEmailChange(newEmail: string) {
      const response = await fetcher(accountContracts.requestEmailChange.path, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(requestEmailChangeSchema.parse({ newEmail })) });
      if (!response.ok) throw await failure(response);
      return parseResponse(accountContracts.requestEmailChange.response, await response.json()).data;
    },
  };
}
export type AccountClient = ReturnType<typeof createAccountClient>;
