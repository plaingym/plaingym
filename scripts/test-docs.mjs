// SPDX-License-Identifier: AGPL-3.0-only
import { createVitest } from 'vitest/node';
import { runDocumentationTests } from './test-selection.mjs';

// Discover every project first: filtering to unit would silently omit a misplaced docs test.
const vitest = await createVitest('test', { watch: false, run: true });
try {
  if (!await runDocumentationTests(vitest)) process.exitCode = 1;
} finally { await vitest.close(); }
