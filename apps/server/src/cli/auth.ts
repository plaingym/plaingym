// SPDX-License-Identifier: AGPL-3.0-only
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { authConfig } from '../infra/auth/config.js';
import { createAccountService, type AccountService } from '../infra/auth/accounts.js';
import { assertOwnerRecovery } from '../areas/staff/auth.reset.js';
import { clock } from '../core/clock.js';
import type { Command, CommandIO } from './index.js';

export interface AuthCliOptions {
  /** Inject the single-gym resolver after database initialization. */
  resolveGymId(): Promise<string>;
  readPassword?: (io: CommandIO) => Promise<string>;
  accounts?: AccountService;
}
async function readPassword(io: CommandIO) {
  // Suppress readline's echo. No password appears in argv, environment, logs or shell history.
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    io.stdout('New password (12-128 characters):');
    const first = await input.question('');
    io.stdout('Confirm password:');
    if (await input.question('') !== first) throw new Error('Passwords do not match');
    return first;
  } finally { input.close(); output.end(); }
}
let configured: AuthCliOptions | undefined;
export function configureAuthCli(options: AuthCliOptions) { configured = options; }
export function createAuthCommands(options: () => AuthCliOptions) : readonly Command[] {
  return [{ id: 'auth', description: 'Recover a local owner account', async run(args, io) {
    if (args[0] !== 'reset-password' || args.length !== 2 || !args[1]?.includes('@')) { io.stderr('Usage: gym-app auth reset-password <email>'); return 2; }
    try {
      const config = authConfig();
      if (config.tenancy !== 'single' || !config.passwordEnabled) throw new Error('Owner password recovery requires single tenancy and password login');
      const dependencies = options();
      const accounts = dependencies.accounts ?? createAccountService(config);
      const user = await accounts.findUserByEmail(args[1]);
      if (!user) throw new Error('Owner account not found');
      const gymId = await dependencies.resolveGymId();
      const newPassword = await (dependencies.readPassword ?? readPassword)(io);
      await accounts.resetPassword({ gymId, userId: user.id, newPassword, clock, authorize: (tx) => assertOwnerRecovery(tx, gymId, user.id) });
      io.stdout('Password reset. All sessions ended.');
      return 0;
    } catch (error) { io.stderr(error instanceof Error ? error.message : 'Password reset failed'); return 1; }
  } }];
}
export const commands = createAuthCommands(() => {
  if (!configured) throw new Error('Initialize the single-gym resolver before owner recovery');
  return configured;
});
