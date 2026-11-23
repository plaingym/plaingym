// SPDX-License-Identifier: AGPL-3.0-only
/* global document, Element, requestAnimationFrame */
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest('#site-menu a, .demo-menu-fallback a') : null;
  if (!link) return;
  const menu = link.closest('#site-menu');
  if (menu?.matches(':popover-open')) menu.hidePopover();
  link.closest('details')?.removeAttribute('open');

  const href = link.getAttribute('href');
  if (!href?.startsWith('#')) return;
  const target = document.getElementById(href.slice(1));
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  // Let the menu close and native fragment navigation scroll before moving focus.
  requestAnimationFrame(() => target.focus({ preventScroll: true }));
});
