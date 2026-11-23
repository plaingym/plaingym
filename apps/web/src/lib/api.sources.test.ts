// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = join(import.meta.dirname, '..');
/** Files that may build an error from a response status themselves. */
const exceptions = new Set(['lib/api.ts', 'features/bookings/client.ts']);
const fromResponseStatus = /new ApiError\(\s*[\w.]*\.status\b/;

/** The 1-based lines of a source text that build an `ApiError` from a response's status. */
function statusErrorLines(text: string): number[] {
  return text.split('\n').flatMap((line, index) => fromResponseStatus.test(line) ? [index + 1] : []);
}
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

describe('refusal helper use', () => {
  it('has no client building an ApiError from a response status outside the shared helper', () => {
    const found = sourceFiles(source).flatMap(path => {
      const name = relative(source, path).split(sep).join('/');
      if (exceptions.has(name)) return [];
      return statusErrorLines(readFileSync(path, 'utf8')).map(line => `${name}:${line}`);
    });
    expect(found).toEqual([]);
  });
  it('flags a probe that builds an ApiError from a response status', () => {
    expect(statusErrorLines("const a = 1;\n  throw new ApiError(response.status, 'x');")).toEqual([2]);
    expect(statusErrorLines("throw new ApiError(result.response.status, 'x')")).toEqual([1]);
    expect(statusErrorLines("throw new ApiError(409, 'conflict')")).toEqual([]);
  });
});
