// SPDX-License-Identifier: AGPL-3.0-only
/* global document, Element */
document.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('#site-menu a, .demo-menu-fallback a') : null;
  if (!link) return;
  const menu = link.closest('#site-menu');
  if (menu?.matches(':popover-open')) menu.hidePopover();
  link.closest('details')?.removeAttribute('open');
});
