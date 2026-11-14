// SPDX-License-Identifier: AGPL-3.0-only
import { createVitest } from 'vitest/node';
import { documentationTests } from './test-selection.mjs';

// Discover every project first: filtering to unit would silently omit a misplaced docs test.
const vitest = await createVitest('test', { watch: false, run: true });
try {
  const docs = documentationTests(await vitest.globTestSpecifications());
  const result = await vitest.runTestSpecifications(docs);
  if (result.unhandledErrors.length || result.testModules.some(module => module.state() === 'failed')) process.exitCode = 1;
} finally { await vitest.close(); }
