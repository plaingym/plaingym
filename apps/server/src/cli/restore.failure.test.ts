// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { setLogSink } from '../core/log.js';
import { reportMaintenanceFailure } from './restore.failure.js';

const leaky = new Error('could not connect to postgres://maintenance:DBPASSWORD@db.invalid/gym; key file /srv/SECRETPATH/identity.txt holds AGE-SECRET-KEY-1PRIVATEKEY');
const redacted = /SECRETPATH|postgres:|DBPASSWORD|PRIVATEKEY/;
function report(args: string[]) {
  const lines: string[] = [], messages: string[] = [], previous = setLogSink((line) => lines.push(line));
  try { reportMaintenanceFailure(args, leaky, (line) => messages.push(line)); } finally { setLogSink(previous); }
  return { lines, messages };
}
describe('maintenance command failure', () => {
  it.each(['restore', 'resume'])('reports a safe restore reason for %s', (command) => {
    const { lines, messages } = report([command]);
    expect(messages).toEqual(['Restore failed: Unexpected error (Error)']);
    expect(redacted.test(lines.join() + messages.join())).toBe(false);
  });
  it('tells the person at the terminal in plain text and logs the cause without its message', () => {
    const { lines, messages } = report(['snapshot']);
    expect(messages).toEqual(['Maintenance command failed; check configuration and restore state']);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', event: 'cli.maintenance_failed', command: 'snapshot', error: { name: 'Error' } });
    expect(lines[0]).not.toMatch(redacted);
    expect(messages.join()).not.toMatch(redacted);
  });
  it('logs a command name only when it looks like one', () => {
    for (const arg of ['/srv/SECRETPATH/restore', 'postgres://maintenance:DBPASSWORD@db.invalid/gym']) {
      const { lines } = report([arg]);
      expect(JSON.parse(lines[0]!)).toMatchObject({ command: null });
      expect(lines[0]).not.toMatch(redacted);
    }
    expect(JSON.parse(report([]).lines[0]!)).toMatchObject({ command: null });
  });
});
