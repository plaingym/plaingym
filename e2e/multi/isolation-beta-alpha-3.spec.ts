// SPDX-License-Identifier: AGPL-3.0-only
import { test } from '../support.js';
import { isolationSweep } from './isolation-sweep.js';

test.use({ trace: 'off', screenshot: 'off' });

test('cross-gym sweep beta-alpha, route group 3/3', async () => {
  await isolationSweep('beta-alpha', 2);
});
