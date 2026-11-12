// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pending requests keep their generation across reloads in this tab. Pass request identity, never credentials.
 * `sent` clears a confirmed send, or starts a deliberate resend after an uncertain outcome.
 */
export function createSendGeneration(namespace = 'send', storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  let current: { key: string; generation: string } | null = null;
  const session = () => storage ?? globalThis.sessionStorage;
  return {
    for(request: unknown): string {
      const key = 'plaingym.pending-send:' + JSON.stringify([namespace, request]);
      if (current?.key !== key) {
        let saved: string | null = null;
        try { saved = session().getItem(key); } catch { /* Storage may be disabled; retain in memory. */ }
        const generation = saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved) ? saved : crypto.randomUUID();
        // Persist before the request leaves: a lost response must survive a remount or reload.
        try { session().setItem(key, generation); } catch { /* Retain in memory when storage is unavailable. */ }
        current = { key, generation };
      }
      return current.generation;
    },
    /** Call once the request went through. */
    sent(): void {
      if (current) { try { session().removeItem(current.key); } catch { /* Storage may be disabled. */ } }
      current = null;
    },
  };
}
