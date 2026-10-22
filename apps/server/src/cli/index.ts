// SPDX-License-Identifier: AGPL-3.0-only
import { Registry, type RegistryEntry } from '@plaingym/shared';
import { commands as auth } from './auth.js';
import { commands as gyms } from './gyms.js';
import { commands as restore } from './restore.js';
import { commands as replay } from './replay.js';

export interface CommandIO {
  stdout(message: string): void;
  stderr(message: string): void;
}
export interface Command extends RegistryEntry {
  readonly description: string;
  run(args: readonly string[], io: CommandIO): Promise<number>;
}
export const commands = new Registry<Command>();
for (const group of [auth, gyms, restore, replay]) commands.registerAll(group);

export async function runCli(args: readonly string[], io: CommandIO): Promise<number> {
  const command = commands.all().find((entry) => entry.id === args[0]);
  if (!command) {
    io.stderr('Unknown command');
    return 2;
  }
  return command.run(args.slice(1), io);
}
