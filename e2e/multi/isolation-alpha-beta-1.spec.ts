// SPDX-License-Identifier: AGPL-3.0-only
import { test } from '../support.js';
import { isolationSweep } from './isolation-sweep.js';

test.use({ trace: 'off', screenshot: 'off' });

test('cross-gym sweep alpha-beta, route group 1/3', async () => {
  await isolationSweep('alpha-beta', 0);
});
