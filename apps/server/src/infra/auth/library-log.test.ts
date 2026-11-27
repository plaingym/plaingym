// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- The test raises Drizzle's query error; it builds no SQL and names no table.
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { setLogSink } from '../../core/log.js';
import { authLibraryLogger } from './library-log.js';

const { log } = authLibraryLogger;
const email = 'member@example.test';
const query = 'select "id" from "auth_user" where "email" = $1';
let lines: string[] = [];
let previous: ReturnType<typeof setLogSink>;
beforeEach(() => { lines = []; previous = setLogSink((line) => { lines.push(line); }); });
afterEach(() => { setLogSink(previous); });
const only = () => { expect(lines).toHaveLength(1); return JSON.parse(lines[0]!) as Record<string, unknown>; };

describe('authLibraryLogger', () => {
  it('asks the library for warnings and errors', () => { expect(authLibraryLogger.level).toBe('warn'); });

  it('describes a query error without its bound parameters', () => {
    const error = new DrizzleQueryError(query, [email]);
    expect(error.message).toContain(`params: ${email}`);
    log('error', 'Failed to create session', error);
    expect(only()).toMatchObject({ event: 'auth.library_error', level: 'error', message: 'Failed to create session', dropped: 0,
      error: { name: error.name, query } });
    expect(lines[0]).not.toContain(email);
  });

  it('drops the bound parameters of a query error passed as the message', () => {
    log('error', new DrizzleQueryError(query, [email, 'secret-token-value']).message);
    expect(only()).toMatchObject({ message: `Failed query: ${query}` });
    expect(lines[0]).not.toContain('secret-token-value');
    expect(lines[0]).not.toContain(email);
  });

  it('replaces addresses in a warning', () => {
    log('warn', `User ${email} not found`);
    expect(only()).toMatchObject({ event: 'auth.library_warning', level: 'warn', message: 'User [address] not found', dropped: 0 });
  });

  it('records a warning that carries an error with the error', () => {
    log('warn', 'x', 'extra', new Error(email), new Error('second'));
    expect(only()).toMatchObject({ event: 'auth.library_warning', level: 'error', dropped: 2, error: { name: 'Error' } });
    expect(lines[0]).not.toContain(email);
    expect(lines[0]).not.toContain('second');
  });

  it('drops every argument that is not an error', () => {
    log('error', 'x', { email }, email);
    expect(only()).toMatchObject({ event: 'auth.library_error', dropped: 2 });
    expect(lines[0]).not.toContain(email);
  });

  it('replaces addresses before cutting a long message', () => {
    log('error', 'a'.repeat(1000));
    expect(only().message).toBe('a'.repeat(300));
    lines = [];
    log('error', `${'a '.repeat(145)}${email}`);
    expect(only().message).toBe(`${'a '.repeat(145)}[address]`.slice(0, 300));
  });

  it('writes nothing for information and debug messages', () => {
    log('info', 'x', new Error('x'));
    log('debug', 'x');
    expect(lines).toEqual([]);
  });

  it('does not throw when the log cannot be written', () => {
    setLogSink(() => { throw new Error('sink'); });
    expect(() => log('error', 'x')).not.toThrow();
    expect(() => log('warn', 'x')).not.toThrow();
  });
});
