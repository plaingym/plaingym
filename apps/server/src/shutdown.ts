// SPDX-License-Identifier: AGPL-3.0-only
import { logError } from './core/log.js';

/** What the process needs to stop: the listening server, then the runtime behind it. */
export interface Stoppable {
  server: { close(callback: (error?: Error) => void): unknown };
  runtime: { stop(): Promise<void> };
}
/** Stop on a signal: close the listener, then the runtime, logging (never throwing) what fails and setting a failing exit code. */
export function shutdown({ server, runtime }: Stoppable): () => void {
  return () => { server.close(async (error) => {
    if (error) {
      logError('server.close_failed', {}, error);
      process.exitCode = 1;
    }
    try { await runtime.stop(); } catch (stopError) { logError('server.stop_failed', {}, stopError); process.exitCode = 1; }
  }); };
}
