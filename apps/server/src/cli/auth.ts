// SPDX-License-Identifier: AGPL-3.0-only
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { authConfig, passwordLogin } from '../infra/auth/config.js';
import { createAccountService, type AccountService } from '../infra/auth/accounts.js';
import { createEmailChangeService, type EmailChangeService } from '../infra/auth/email-change.js';
import { assertOwnerRecovery } from '../areas/staff/auth.reset.js';
import { AppError } from '@plaingym/shared';
import { ZodError } from 'zod';
import { clock } from '../core/clock.js';
import type { Command, CommandIO } from './index.js';

export interface AuthCliOptions {
  /** Inject the single-gym resolver after database initialization. */
  resolveGymId(): Promise<string>;
  readPassword?: (io: CommandIO) => Promise<string>;
  accounts?: AccountService;
  /** Per-gym email availability; password login under `auto` is off when the gym can send email. */
  smtpConfigured?(gymId: string): Promise<boolean>;
  emailChange?: EmailChangeService;
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
const usage = 'Usage: gym-app auth reset-password <email>\n       gym-app auth change-email <current-email> <new-email>';
/**
 * Moves a current owner's login to a new address at once, for an owner who lost the old mailbox: server access is the
 * proof, as for password recovery. Every session of the login ends, a linked Google account is unlinked, and the gym's
 * audit records it as the system. No link is sent; the owner then signs in with the new address.
 */
async function changeEmail(args: readonly string[], io: CommandIO, options: () => AuthCliOptions): Promise<number> {
  if (args.length !== 3 || !args[1]?.includes('@') || !args[2]?.includes('@')) { io.stderr(usage); return 2; }
  try {
    const config = authConfig();
    if (config.tenancy !== 'single') throw new Error('Changing a sign-in email from the server requires single tenancy');
    const dependencies = options();
    const service = dependencies.emailChange ?? createEmailChangeService({ config });
    const gymId = await dependencies.resolveGymId();
    await service.changeByOperator({ gymId, from: args[1], to: args[2], clock, authorize: (tx, userId) => assertOwnerRecovery(tx, gymId, userId) });
    io.stdout('Sign-in email changed. All sessions ended; sign in with the new address.');
    return 0;
  } catch (error) {
    if (error instanceof AppError && error.code === 'conflict') io.stderr('Another login uses the new address');
    else if (error instanceof ZodError) io.stderr('The new address is not a valid email');
    else io.stderr(error instanceof Error ? error.message : 'Email change failed');
    return 1;
  }
}
let configured: AuthCliOptions | undefined;
export function configureAuthCli(options: AuthCliOptions) { configured = options; }
export function createAuthCommands(options: () => AuthCliOptions) : readonly Command[] {
  return [{ id: 'auth', description: 'Recover a local owner account', async run(args, io) {
    if (args[0] === 'change-email') return changeEmail(args, io, options);
    if (args[0] !== 'reset-password' || args.length !== 2 || !args[1]?.includes('@')) { io.stderr(usage); return 2; }
    try {
      const config = authConfig();
      if (config.tenancy !== 'single' || !config.passwordEnabled) throw new Error('Owner password recovery requires single tenancy and password login');
      const dependencies = options();
      const accounts = dependencies.accounts ?? createAccountService(config);
      const user = await accounts.findUserByEmail(args[1]);
      if (!user) throw new Error('Owner account not found');
      const gymId = await dependencies.resolveGymId();
      if (dependencies.smtpConfigured && !passwordLogin(config, await dependencies.smtpConfigured(gymId)))
        throw new Error('Password login is off for this gym; sign in with an email link instead');
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
