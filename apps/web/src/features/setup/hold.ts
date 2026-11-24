// SPDX-License-Identifier: AGPL-3.0-only
import { createContext } from 'react';

export const SetupHoldContext = createContext<{ hold(): void; release(): void } | null>(null);
