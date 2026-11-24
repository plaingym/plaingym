// SPDX-License-Identifier: AGPL-3.0-only
import { createContext } from 'react';

export type StripeConnected = { mode: 'test' | 'live' | null; webhookRegistered: boolean };

export const SetupHoldContext = createContext<{
  connected: StripeConnected | null;
  hold(connected: StripeConnected): void;
  /** The wizard answers once the next step is known, so the step keeps its confirmation on screen until then. */
  release(): void | Promise<void>;
} | null>(null);
