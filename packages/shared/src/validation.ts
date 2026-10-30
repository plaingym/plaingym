// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Browser entry points call this before parsing anything. Zod otherwise probes for `eval` and compiles object
 * parsers with `new Function`, which a Content Security Policy without 'unsafe-eval' reports (or blocks).
 * Validation results are the same; only the compiled fast path is skipped.
 */
export function disableSchemaCompilation(): void {
  z.config({ jitless: true });
}
