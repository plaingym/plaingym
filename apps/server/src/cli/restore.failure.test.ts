// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { setLogSink } from '../core/log.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { reportMaintenanceFailure } from './restore.failure.js';
// Exercise the maintenance boundary's schema diagnostic without opening a database connection.
// eslint-disable-next-line no-restricted-imports
import { assertSchemaCompatibility } from '@plaingym/db/client';

const leaky = new Error('could not connect to postgres://maintenance:DBPASSWORD@db.invalid/gym; key file /srv/SECRETPATH/identity.txt holds AGE-SECRET-KEY-1PRIVATEKEY');
const redacted = /SECRETPATH|postgres:|DBPASSWORD|PRIVATEKEY/;
function report(args: string[], error: unknown = leaky) {
  const lines: string[] = [], messages: string[] = [], previous = setLogSink((line) => lines.push(line));
  try { reportMaintenanceFailure(args, error, (line) => messages.push(line)); } finally { setLogSink(previous); }
  return { lines, messages };
}
describe('maintenance command failure', () => {
  it.each(['restore', 'resume'])('reports a safe restore reason for %s', (command) => {
    const { lines, messages } = report([command]);
    expect(messages).toEqual(['Restore failed: Unexpected error (Error)']);
    expect(redacted.test(lines.join() + messages.join())).toBe(false);
  });
  it('keeps checked schema recovery details visible and rejects unsafe diagnostic metadata', () => {
    const schema = { APP_VERSION: '1.1.0', SCHEMA_ROLLBACK_FLOOR: 'v1.2.0', SCHEMA_RELEASE: 'v1.3.0', SCHEMA_SNAPSHOT: '00000000-0000-4000-8000-000000000001' };
    const refusal = (env: NodeJS.ProcessEnv) => { try { assertSchemaCompatibility(env); } catch (error) { return report(['migrate'], error); } throw new Error('Expected a schema refusal'); };
    expect(refusal(schema).messages[0]).toMatch(/Cannot start 1.1.0.*v1.3.0.*v1.2.0.*update.sh --rollback.*00000000-0000-4000-8000-000000000001/);
    const unsafe = refusal({ ...schema, SCHEMA_RELEASE: 'postgres://DBPASSWORD', SCHEMA_SNAPSHOT: '/srv/SECRETPATH' });
    expect(unsafe.messages[0]).toContain('version-history.tsv');
    expect(unsafe.messages.join() + unsafe.lines.join()).not.toMatch(redacted);
  });
  it('tells the person at the terminal in plain text and logs the cause without its message', () => {
    const { lines, messages } = report(['snapshot']);
    expect(messages).toEqual(['Maintenance command failed; check configuration and restore state']);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', event: 'cli.maintenance_failed', command: 'snapshot', error: { name: 'Error' } });
    expect(lines[0]).not.toMatch(redacted);
    expect(messages.join()).not.toMatch(redacted);
  });
  it('prints the fixed text of a wrong maintenance role for the deployed migrate command', () => {
    const failure = (() => { try { return new PostgresMaintenance('postgres://app:DBPASSWORD@db.invalid/gym'); } catch (error) { return error; } })();
    const messages: string[] = [], previous = setLogSink(() => undefined);
    try { reportMaintenanceFailure(['migrate'], failure, (line) => messages.push(line)); } finally { setLogSink(previous); }
    expect(messages).toEqual(['Backups and restore require maintenance']);
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
