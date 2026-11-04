// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { BookingSessionCounts } from '@plaingym/shared/contracts';

/** Booking numbers for the whole session, published by a session panel for the session dialog's summary. */
export type SessionCounts = BookingSessionCounts;
interface SessionSummary {
  publish: (counts: SessionCounts | null) => void;
  /** Rises each time something in the dialog changed the session's bookings or check-ins. */
  changed: number;
  notify: () => void;
}

const SessionSummaryContext = createContext<SessionSummary | null>(null);

/** The session dialog provides this around its panels; a panel publishes through `usePublishSessionCounts`, so the schedule never imports a feature. */
export function SessionCountsProvider({ publish, changed = 0, notify, children }: { publish: SessionSummary['publish']; changed?: number; notify?: () => void; children: ReactNode }) {
  return <SessionSummaryContext.Provider value={{ publish, changed, notify: notify ?? (() => undefined) }}>{children}</SessionSummaryContext.Provider>;
}

/** Shows `counts` in the surrounding session dialog's summary (`null` clears it). Does nothing outside a dialog, and clears the summary on unmount. */
export function usePublishSessionCounts(counts: SessionCounts | null) {
  const publish = useContext(SessionSummaryContext)?.publish;
  useEffect(() => {
    publish?.(counts);
  }, [publish, counts]);
  useEffect(() => () => publish?.(null), [publish]);
}

/** A number that changes whenever a panel or the dialog reported a change; a panel that shows counts reloads when it changes. 0 outside a dialog. */
export function useSessionChanged(): number { return useContext(SessionSummaryContext)?.changed ?? 0; }

/** Tells the dialog (and so the panels that show counts) that this panel changed the session, for example a check-in. A no-op outside a dialog. */
export function useNotifySessionChanged(): () => void { return useContext(SessionSummaryContext)?.notify ?? (() => undefined); }
