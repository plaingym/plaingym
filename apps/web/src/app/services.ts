// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../lib/response.js';
import { shellContracts, shellBootstrapResponseSchema, type ShellBootstrap, type ShellSession } from '@plaingym/shared/contracts';
import { createJsonTransport } from '../lib/api.js';
export type { ShellBootstrap, ShellSession };
export interface ShellServices {
  loadBootstrap(signal?: AbortSignal): Promise<ShellBootstrap>;
  signInWithPassword(email: string, password: string): Promise<void>;
  requestMagicLink(email: string): Promise<void>;
  /** Starts Google sign-in and returns Google's address to continue at; offered only when the bootstrap says it is on. */
  signInWithGoogle?(): Promise<string>;
  signOut(): Promise<void>;
}
/** Google's authorization page: the only address a Google sign-in leaves the gym for. */
const googleAuthorizeOrigin = 'https://accounts.google.com';
export function sessionDestination(session: ShellSession): '/admin' | '/portal' | null {
  return session.roles.length > 0 ? '/admin' : session.member ? '/portal' : null;
}
/** Integration supplies the bootstrap projection; it must derive all access from the server. */
export function createShellServices(
  loadBootstrap: ShellServices['loadBootstrap'], fetcher: typeof fetch = fetch,
): ShellServices {
  const request = createJsonTransport(fetcher);
  return {
    loadBootstrap,
    async signInWithPassword(email, password) {
      await request('/api/auth/sign-in/email', { email: email.trim().toLowerCase(), password });
    },
    async requestMagicLink(email) {
      await request('/api/auth/sign-in/magic-link', {
        email: email.trim().toLowerCase(), callbackURL: '/login', errorCallbackURL: '/login',
      });
    },
    async signInWithGoogle() {
      // The server fixes where Google returns; only Google's own authorization page is followed.
      const { url } = await request<{ url?: unknown }>('/api/auth/sign-in/social', { provider: 'google' });
      if (typeof url !== 'string' || new URL(url).origin !== googleAuthorizeOrigin) throw new Error('Unexpected Google sign-in address');
      return url;
    },
    async signOut() { await request('/api/auth/sign-out', {}); },
  };
}
export function createBootstrapLoader(fetcher: typeof fetch = fetch): ShellServices['loadBootstrap'] {
  const request = createJsonTransport(fetcher);
  return async (signal) => parseResponse(shellBootstrapResponseSchema, await request(shellContracts.bootstrap.path, undefined, signal)).data;
}
export const defaultShellServices = createShellServices(createBootstrapLoader());
