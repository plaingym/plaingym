// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = join(import.meta.dirname, '..');
/** Files that may build an error from a non-literal status themselves. */
const statusExceptions = new Set(['lib/api.ts']);
/** Files allowed to call `reportApiRefusal` directly instead of `refusalError` or `readRefusal`. */
const reportExceptions = new Set(['lib/api.ts']);
const nonLiteralStatusError = /new\s+ApiError\s*\((?!\s*\d)/g;
const directRefusalReport = /\breportApiRefusal\s*\(/g;

function matchingLines(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map(
    match => text.slice(0, match.index).split('\n').length,
  );
}
/** The 1-based lines of a source text that build an `ApiError` from a non-literal status. */
function statusErrorLines(text: string): number[] {
  return matchingLines(text, nonLiteralStatusError);
}
/** The 1-based lines of a source text that call `reportApiRefusal`. */
function refusalReportLines(text: string): number[] {
  return matchingLines(text, directRefusalReport);
}
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

describe('refusal helper use', () => {
  it('has no client building an ApiError from a non-literal status outside the shared helper', () => {
    const found = sourceFiles(source).flatMap(path => {
      const name = relative(source, path).split(sep).join('/');
      if (statusExceptions.has(name)) return [];
      return statusErrorLines(readFileSync(path, 'utf8')).map(line => `${name}:${line}`);
    });
    expect(found).toEqual([]);
  });
  it('has no client calling reportApiRefusal directly outside the listed exceptions', () => {
    const found = sourceFiles(source).flatMap(path => {
      const name = relative(source, path).split(sep).join('/');
      if (reportExceptions.has(name)) return [];
      return refusalReportLines(readFileSync(path, 'utf8')).map(line => `${name}:${line}`);
    });
    expect(found).toEqual([]);
  });
  it('flags probes that build an ApiError from a non-literal status, including split and optional forms', () => {
    expect(statusErrorLines("const a = 1;\n  throw new ApiError(response.status, 'x');")).toEqual([2]);
    expect(statusErrorLines("throw new ApiError(result.response.status, 'x')")).toEqual([1]);
    expect(statusErrorLines("throw new ApiError(\n  response.status, 'x')")).toEqual([1]);
    expect(statusErrorLines("throw new ApiError(response?.status ?? 500, 'x')")).toEqual([1]);
    expect(statusErrorLines("const status = response.status;\nthrow new ApiError(status, 'x')")).toEqual([2]);
    expect(statusErrorLines("throw new ApiError(409, 'conflict')")).toEqual([]);
    expect(statusErrorLines("throw new ApiError(\n  409, 'conflict')")).toEqual([]);
  });
  it('flags probes that call reportApiRefusal directly, ignoring imports', () => {
    expect(refusalReportLines("import { reportApiRefusal } from './api.js';\nawait reportApiRefusal(response);")).toEqual([2]);
    expect(refusalReportLines("await reportApiRefusal\n  (response)")).toEqual([1]);
  });
});
