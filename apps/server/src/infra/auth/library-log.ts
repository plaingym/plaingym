// SPDX-License-Identifier: AGPL-3.0-only
import type { BetterAuthOptions } from 'better-auth';
import { logError, logWarn } from '../../core/log.js';

const address = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g;
// The library also passes a query error's message as the message itself; its bound parameters start on this line.
const boundParameters = /\r?\nparams:/;
const longestMessage = 300;

/**
 * Better Auth's warnings and errors as structured log lines. The message is kept without a query's bound parameters,
 * with addresses replaced and cut to length; the first error argument is described by `describeError`; every other
 * argument is dropped, because it can hold personal data, tokens or a request. Never throws.
 */
export const authLibraryLogger = {
  level: 'warn',
  log(level, message, ...args: unknown[]) {
    if (level !== 'warn' && level !== 'error') return;
    try {
      const text = (String(message).split(boundParameters)[0] ?? '').replace(address, '[address]').slice(0, longestMessage);
      const error = args.find((value) => value instanceof Error);
      const fields = { message: text, dropped: args.length - (error === undefined ? 0 : 1) };
      if (level === 'error') logError('auth.library_error', fields, error);
      else if (error === undefined) logWarn('auth.library_warning', fields);
      else logError('auth.library_warning', fields, error);
    } catch {
      // A line that can't be written is lost: logging never fails the request that caused it.
    }
  },
} satisfies NonNullable<BetterAuthOptions['logger']>;
