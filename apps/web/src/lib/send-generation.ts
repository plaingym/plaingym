// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Picks the `sendGeneration` of an emailing request. A failed try keeps its generation, so trying the same request again
 * can't send a second email or replace the link in one that may have arrived. Changing the request, or sending again
 * after it went through, is a deliberate new send and gets a new generation.
 */
export function createSendGeneration() {
  let current: { request: string; generation: string } | null = null;
  return {
    for(request: unknown): string {
      const identity = JSON.stringify(request);
      if (current?.request !== identity) current = { request: identity, generation: crypto.randomUUID() };
      return current.generation;
    },
    /** Call once the request went through. */
    sent(): void { current = null; },
  };
}
