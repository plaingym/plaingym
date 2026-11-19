// SPDX-License-Identifier: AGPL-3.0-only
// Runs blocking in <head> before the app mounts, so a stored choice paints the first frame.
// Keep the key, classes and colours in step with `theme.ts`.
(function () {
  var key = 'plaingym.theme';
  var kiosk = location.pathname === '/kiosk' || location.pathname.indexOf('/kiosk/') === 0;
  var choice = 'system';
  if (!kiosk) {
    try {
      var stored = window.localStorage.getItem(key);
      if (stored === 'light' || stored === 'dark' || stored === 'system') choice = stored;
    } catch { /* Storage can be blocked; System stays. */ }
  }
  var root = document.documentElement;
  root.classList.remove('theme-system', 'light', 'dark');
  root.classList.add(choice === 'system' ? 'theme-system' : choice);
  var colors = { light: '#ffffff', dark: '#0c1514' };
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var index = 0; index < metas.length; index++) {
    var scheme = metas[index].getAttribute('data-theme-scheme') === 'dark' ? 'dark' : 'light';
    metas[index].setAttribute('content', colors[choice === 'system' ? scheme : choice]);
  }
})();
