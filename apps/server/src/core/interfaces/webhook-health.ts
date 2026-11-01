// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from '@plaingym/shared';
import type { Id, IsoInstant } from '@plaingym/shared/contracts';
import { clock as systemClock } from '../clock.js';
import { instant } from './common.js';

/** A failure counts as recent when its event was received within this long before the check. */
export const recentWebhookFailureMs = 7 * 24 * 60 * 60 * 1000;
export interface WebhookHealth {
  readonly lastReceivedAt: IsoInstant | null;
  readonly lastProcessedAt: IsoInstant | null;
  readonly pendingCount: number;
  /** Events that failed and are still unprocessed: recent and older ones together. A replay that succeeds clears one. */
  readonly failedCount: number;
  /** The part of `failedCount` received within `recentWebhookFailureMs`; the rest are older and still unresolved. */
  readonly recentFailedCount: number;
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
  readonly #clock: Clock;
  constructor(events: readonly WebhookHealthFixture[] = [], clock: Clock = systemClock) {
    this.#events = structuredClone(events); this.#clock = clock;
  }
  async get(gymId: Id): Promise<WebhookHealth> {
    let lastReceivedAt: IsoInstant | null = null;
    let lastProcessedAt: IsoInstant | null = null;
    let pendingCount = 0;
    let failedCount = 0;
    let recentFailedCount = 0;
    const since = this.#clock.now().getTime() - recentWebhookFailureMs;
    for (const event of this.#events) {
      if (event.gymId !== gymId) continue;
      if (lastReceivedAt === null || instant(event.receivedAt) > instant(lastReceivedAt)) lastReceivedAt = event.receivedAt;
      if (event.processedAt !== null && (lastProcessedAt === null || instant(event.processedAt) > instant(lastProcessedAt)))
        lastProcessedAt = event.processedAt;
      if (event.failed) { failedCount++; if (instant(event.receivedAt) >= since) recentFailedCount++; }
      else if (event.processedAt === null) pendingCount++;
    }
    return { lastReceivedAt, lastProcessedAt, pendingCount, failedCount, recentFailedCount };
  }
}
