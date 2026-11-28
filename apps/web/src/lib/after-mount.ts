// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';

/**
 * False until `delayMs` after the component mounted. A screen reader may not announce a live region that mounts with its text
 * already in it, so a status mounts empty and shows its text once this is true.
 */
export function useAfterMount(delayMs = 100): boolean {
  const [after, setAfter] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setAfter(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return after;
}
