// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { setLogSink } from './core/log.js';
import { shutdown } from './shutdown.js';

const leaky = () => new Error('listen failed for /srv/SECRETPATH/app.sock using postgres://app:DBPASSWORD@db.invalid/gym with rk_test_SECRETKEY');
const redacted = /SECRETPATH|postgres:|DBPASSWORD|rk_test_SECRETKEY/;
let previousExitCode: typeof process.exitCode;
afterEach(() => { process.exitCode = previousExitCode; });
function capture() {
  previousExitCode = process.exitCode;
  const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
  return { lines, restore: () => setLogSink(previous) };
}
describe('shutdown', () => {
  it('closes the server, then stops the runtime, and logs nothing when both succeed', async () => {
    const { lines, restore } = capture(), order: string[] = [];
    try {
      const stop = shutdown({ server: { close: (callback) => { order.push('close'); void callback(); } },
        runtime: { async stop() { order.push('stop'); } } });
      stop(); await Promise.resolve(); await Promise.resolve();
      expect(order).toEqual(['close', 'stop']); expect(lines).toEqual([]);
    } finally { restore(); }
  });
  it('logs a close failure and a stop failure without their messages, and fails the exit code', async () => {
    const { lines, restore } = capture();
    try {
      process.exitCode = undefined;
      let done: () => void = () => {};
      const finished = new Promise<void>((resolve) => { done = resolve; });
      shutdown({ server: { close: (callback) => { void callback(leaky()); } },
        runtime: { async stop() { try { throw leaky(); } finally { done(); } } } })();
      await finished; await new Promise((resolve) => setImmediate(resolve));
      expect(lines.map((line) => JSON.parse(line).event)).toEqual(['server.close_failed', 'server.stop_failed']);
      for (const line of lines) { expect(JSON.parse(line)).toMatchObject({ level: 'error', error: { name: 'Error' } }); expect(line).not.toMatch(redacted); }
      expect(process.exitCode).toBe(1);
    } finally { restore(); }
  });
});
