// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';

/** Keep a hash target in view while sibling sections finish loading. The first user interaction
 * hands scrolling and focus back to the user; a new hash starts another navigation. */
export function useSectionHash(id: string, listed: boolean) {
  useEffect(() => {
    if (!listed) return;
    let stopFollowing = () => {};
    const followHash = () => {
      stopFollowing();
      let target: string;
      try { target = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
      if (target !== id) return;
      const section = document.getElementById(id), container = section?.parentElement;
      if (!section || !container) return;
      let frame: number | null = null, following = true;
      const reveal = () => {
        frame = null;
        if (!following) return;
        section.scrollIntoView?.({ block: 'start' });
        section.focus({ preventScroll: true });
      };
      const schedule = () => { if (following && frame === null) frame = window.requestAnimationFrame(reveal); };
      const mutations = new MutationObserver(schedule);
      mutations.observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
      const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
      sizes?.observe(container);
      const focusChanged = (event: FocusEvent) => { if (event.target !== section) schedule(); };
      container.addEventListener('focusin', focusChanged);
      const interactions = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
      const stop = () => {
        following = false;
        mutations.disconnect(); sizes?.disconnect();
        container.removeEventListener('focusin', focusChanged);
        if (frame !== null) window.cancelAnimationFrame(frame);
        for (const event of interactions) window.removeEventListener(event, stop, true);
      };
      stopFollowing = stop;
      for (const event of interactions) window.addEventListener(event, stop, { capture: true, passive: true });
      reveal(); schedule();
    };
    followHash();
    window.addEventListener('hashchange', followHash);
    return () => { window.removeEventListener('hashchange', followHash); stopFollowing(); };
  }, [id, listed]);
}
