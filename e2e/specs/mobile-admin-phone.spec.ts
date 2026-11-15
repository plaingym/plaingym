// SPDX-License-Identifier: AGPL-3.0-only
import { test } from '../support.js';
import { adminScreens } from './mobile-admin.js';
import { viewports } from './mobile-screens.js';

test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(() => { test.setTimeout(270_000); });

test('admin screens at phone width: find a member, move a session, check in, promote, dashboard', async ({ browser, install }, info) => {
  await adminScreens(browser, install, info, viewports[0]);
});
