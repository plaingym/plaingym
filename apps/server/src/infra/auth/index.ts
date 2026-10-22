// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';

export interface Session {
  readonly userId: string;
}
export interface Auth {
  /** The adapter is bound to the resolved gym before any session is read. */
  getSession(request: Request): Promise<Session | null>;
}

export class FakeAuth implements Auth {
  readonly #sessions = new Map<string, { userId: string; gymId: string }>();
  constructor(readonly gymId: string) {}
  seedSession(token: string, session: { userId: string; gymId: string }): void {
    this.#sessions.set(token, { ...session });
  }
  revokeSession(token: string): void {
    this.#sessions.delete(token);
  }
  async getSession(request: Request): Promise<Session | null> {
    assertNoTransaction('auth.getSession');
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    const session = token ? this.#sessions.get(token) : undefined;
    return session?.gymId === this.gymId ? { userId: session.userId } : null;
  }
}
