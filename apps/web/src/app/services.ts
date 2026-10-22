// SPDX-License-Identifier: AGPL-3.0-only
import type { StaffRole } from '@plaingym/shared';
import { createJsonTransport } from '../lib/api.js';
export interface ShellSession {
  readonly userId: string;
  readonly roles: readonly StaffRole[];
  readonly member: boolean;
}
export interface ShellBootstrap {
  readonly gym: { readonly id: string; readonly name: string; readonly enabledModules: readonly string[] };
  readonly session: ShellSession | null;
  readonly login: { readonly password: boolean; readonly magicLink: boolean };
}
export interface ShellServices {
  loadBootstrap(signal?: AbortSignal): Promise<ShellBootstrap>;
  signInWithPassword(email: string, password: string): Promise<void>;
  requestMagicLink(email: string): Promise<void>;
  signOut(): Promise<void>;
}
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
    async signOut() { await request('/api/auth/sign-out', {}); },
  };
}
// TODO(CCR): replace this loader when the shared gym/session/login bootstrap contract is frozen.
// Fail closed while authentication and tenant middleware are being connected.
export const defaultShellServices = createShellServices(async () => {
  throw new Error('Shell bootstrap adapter is not configured');
});
