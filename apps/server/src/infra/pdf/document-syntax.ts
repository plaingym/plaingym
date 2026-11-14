// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-control-regex -- PDF whitespace includes the NUL byte. */
import { AppError } from '@plaingym/shared';
import { pdfText } from './messages.js';

export interface PdfSyntaxBudget { nodes: number }
function malformed(): never { throw new AppError('invalid_request', pdfText('malformedComplex')); }

/** Bound syntax before the vendor recursively constructs untrusted PDF objects. */
export function scanPdfObject(text: string, start: number, budget: PdfSyntaxBudget): number {
  let at = start;
  const skip = () => {
    for (;;) {
      while (/[\x00\t\n\f\r ]/.test(text[at] ?? '!')) at++;
      if (text[at] !== '%') return;
      while (at < text.length && !/[\r\n]/.test(text[at]!)) at++;
    }
  };
  const match = (pattern: RegExp) => {
    const found = pattern.exec(text.slice(at));
    if (!found) malformed();
    at += found[0].length;
    return found;
  };
  const value = (depth = 0): void => {
    if (depth > 40 || ++budget.nodes > 100_000) malformed();
    skip();
    if (text.startsWith('<<', at)) {
      at += 2; skip();
      const keys = new Set<string>();
      while (!text.startsWith('>>', at)) {
        const key = match(/^\/[^\s()[\]<>/%]+/)[0].replace(/#([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        if (keys.has(key)) malformed();
        keys.add(key); value(depth + 1); skip();
      }
      at += 2;
    } else if (text[at] === '[') {
      at++; skip();
      while (text[at] !== ']') { value(depth + 1); skip(); }
      at++;
    } else if (text[at] === '(') {
      at++; let nesting = 1;
      while (nesting) {
        if (at >= text.length) malformed();
        const ch = text[at++];
        if (ch === '\\') at++;
        else if (ch === '(') nesting++;
        else if (ch === ')') nesting--;
      }
    } else if (text[at] === '<') match(/^<[\da-f\x00\t\n\f\r ]*>/i);
    else if (text[at] === '/') match(/^\/[^\s()[\]<>/%]*/);
    else match(/^(?:\d+\s+\d+\s+R\b|[+-]?(?:\d+\.?\d*|\.\d+)|true\b|false\b|null\b)/);
  };
  value();
  return at;
}
