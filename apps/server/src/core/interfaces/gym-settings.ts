// SPDX-License-Identifier: AGPL-3.0-only
import type { Currency, Id, Revision } from '@plaingym/shared/contracts';
import { currencySchema, revisionSchema } from '@plaingym/shared/contracts';
import { notFound, scopedKey } from './common.js';

/** Safe explicit projection of gym config. Never returns encrypted settings. */
export interface GymSettings {
  readonly gymId: Id;
  readonly timezone: string;
  readonly currency: Currency;
  readonly billingEnabled: boolean;
  readonly memberEmailsEnabled: boolean;
  readonly websiteEnabled: boolean;
  readonly bookingWindowDays: number;
  readonly cancellationCutoffMinutes: number;
  /** Open-mat visits count toward classes attended only when enabled. */
  readonly openMatCountsAsClass: boolean;
  readonly revision: Revision;
}
export interface GymSettingsAccessor { get(gymId: Id): Promise<GymSettings>; }
export class FakeGymSettingsAccessor implements GymSettingsAccessor {
  readonly #settings = new Map<Id, GymSettings>();
  constructor(settings: readonly GymSettings[] = []) { settings.forEach((item) => this.set(item)); }
  set(settings: GymSettings): void {
    scopedKey(settings.gymId, settings.gymId);
    currencySchema.parse(settings.currency);
    revisionSchema.parse(settings.revision);
    new Intl.DateTimeFormat('en', { timeZone: settings.timezone });
    for (const value of [settings.bookingWindowDays, settings.cancellationCutoffMinutes])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid booking rule');
    const { gymId, timezone, currency, billingEnabled, memberEmailsEnabled, websiteEnabled,
      bookingWindowDays, cancellationCutoffMinutes, openMatCountsAsClass, revision } = settings;
    this.#settings.set(gymId, { gymId, timezone, currency, billingEnabled, memberEmailsEnabled,
      websiteEnabled, bookingWindowDays, cancellationCutoffMinutes, openMatCountsAsClass, revision });
  }
  async get(gymId: Id): Promise<GymSettings> {
    const value = this.#settings.get(gymId) ?? notFound();
    return structuredClone(value);
  }
}
