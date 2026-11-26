// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect } from 'react';

/**
 * While a phone menu is open, what it covers outside its shell takes no focus or presses: every element marked
 * `data-menu-covers` (the skip link, the demo rows and the source footer) is inert, and gets back what it had when the
 * menu closes or its shell unmounts. A shell marks its own `main` inert itself.
 */
export function useMenuCovers(open: boolean) {
  useLayoutEffect(() => {
    if (!open) return;
    const covered = [...document.querySelectorAll<HTMLElement>('[data-menu-covers]')]
      .map(element => ({ element, inert: element.inert }));
    for (const { element } of covered) element.inert = true;
    return () => { for (const { element, inert } of covered) element.inert = inert; };
  }, [open]);
}
