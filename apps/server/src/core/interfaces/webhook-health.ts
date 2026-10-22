// SPDX-License-Identifier: AGPL-3.0-only
import type { Id, IsoInstant } from '@plaingym/shared/contracts';
import { instant } from './common.js';

export interface WebhookHealth {
  readonly lastReceivedAt: IsoInstant | null;
  readonly lastProcessedAt: IsoInstant | null;
  readonly pendingCount: number;
  readonly failedCount: number;
}
/** Implemented by the webhook inbox; no payloads, secrets or errors escape. */
export interface WebhookHealthQuery { get(gymId: Id): Promise<WebhookHealth>; }
export interface WebhookHealthFixture {
  readonly gymId: Id | null;
  readonly receivedAt: IsoInstant;
  readonly processedAt: IsoInstant | null;
  readonly failed: boolean;
}
export class FakeWebhookHealthQuery implements WebhookHealthQuery {
  readonly #events: readonly WebhookHealthFixture[];
  constructor(events: readonly WebhookHealthFixture[] = []) { this.#events = structuredClone(events); }
  async get(gymId: Id): Promise<WebhookHealth> {
    let lastReceivedAt: IsoInstant | null = null;
    let lastProcessedAt: IsoInstant | null = null;
    let pendingCount = 0;
    let failedCount = 0;
    for (const event of this.#events) {
      if (event.gymId !== gymId) continue;
      if (lastReceivedAt === null || instant(event.receivedAt) > instant(lastReceivedAt)) lastReceivedAt = event.receivedAt;
      if (event.processedAt !== null && (lastProcessedAt === null || instant(event.processedAt) > instant(lastProcessedAt)))
        lastProcessedAt = event.processedAt;
      if (event.failed) failedCount++;
      else if (event.processedAt === null) pendingCount++;
    }
    return { lastReceivedAt, lastProcessedAt, pendingCount, failedCount };
  }
}
