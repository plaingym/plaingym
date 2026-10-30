// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { disableSchemaCompilation } from './validation.js';

describe('schema compilation', () => {
  it('turns off compiled parsers without changing validation results', () => {
    disableSchemaCompilation();
    expect(z.config().jitless).toBe(true);
    const schema = z.strictObject({ name: z.string().min(1), count: z.number().int() });
    expect(schema.parse({ name: 'a', count: 1 })).toEqual({ name: 'a', count: 1 });
    expect(schema.safeParse({ name: '', count: 1.5, extra: true }).success).toBe(false);
  });
});
