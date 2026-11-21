// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { handlerFailureReasons } from './inbox.js';

it('allows exactly the fixed failure texts thrown by billing handlers', () => {
  const directory = new URL('./handlers/', import.meta.url);
  const thrown = readdirSync(directory).filter((file) => file.endsWith('.ts') && !/\.(?:test|spec)\./.test(file))
    .flatMap((file) => [...readFileSync(new URL(file, directory), 'utf8').matchAll(/throw new Error\((['`])(.*?)\1\)/g)])
    .flatMap(([, , text]) => {
      // parentPayment's one template: `${kind} payment is unresolved`, with kind 'Refund' or 'Dispute'.
      const rest = /^\$\{kind\}( .*)$/.exec(text!)?.[1];
      return rest ? ['Refund', 'Dispute'].map((kind) => kind + rest) : [text!];
    });
  expect(thrown.length).toBeGreaterThan(30);
  expect(handlerFailureReasons).toEqual(new Set(thrown));
  expect(thrown.filter((text) => /\$\{/.test(text))).toEqual([]);
});
