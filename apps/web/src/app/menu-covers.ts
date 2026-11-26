// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect } from 'react';

const marked = '[data-menu-covers]';

/**
 * While a phone menu is open, what it covers outside its shell takes no focus or presses: every element marked
 * `data-menu-covers` (the skip link, the demo rows, the demo error blocks and the source footer) is inert, one added
 * while the menu is open too, and gets back what it had when the menu closes or its shell unmounts. A focus that lands
 * in one goes back to where it was. A shell marks its own `main` inert itself.
 */
export function useMenuCovers(open: boolean) {
  useLayoutEffect(() => {
    if (!open) return;
    const covered: { element: HTMLElement; inert: boolean }[] = [];
    const cover = (element: HTMLElement) => {
      if (covered.some(entry => entry.element === element)) return;
      covered.push({ element, inert: element.inert });
      element.inert = true;
    };
    document.querySelectorAll<HTMLElement>(marked).forEach(cover);
    const observer = new MutationObserver(records => {
      for (const node of records.flatMap(record => [...record.addedNodes])) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(marked)) cover(node);
        node.querySelectorAll<HTMLElement>(marked).forEach(cover);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // A new element can take the focus before the observer has made it inert. Returning the focus raises this event
    // again, so a return in progress is left alone: where it was may itself be in a marked element.
    let returning = false;
    const returnFocus = ({ target, relatedTarget }: FocusEvent) => {
      if (returning || !(target instanceof Element) || !target.closest(marked)) return;
      if (!(relatedTarget instanceof HTMLElement) || !relatedTarget.isConnected) return;
      returning = true;
      relatedTarget.focus({ preventScroll: true });
      returning = false;
    };
    document.addEventListener('focusin', returnFocus);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', returnFocus);
      for (const { element, inert } of covered) element.inert = inert;
    };
  }, [open]);
}
