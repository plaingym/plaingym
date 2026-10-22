// SPDX-License-Identifier: AGPL-3.0-only
import type { Command } from './index.js';
import { setupLink } from '../areas/setup/setup.token.js';

export function createSetupLinkCommand(env: NodeJS.ProcessEnv = process.env): Command {
  return { id: 'setup-link', description: 'Print the private first-boot setup link', async run(args, io) {
  if (args.length) { io.stderr('Usage: setup-link'); return 2; }
  try {
    const origin = env.PUBLIC_ORIGIN ?? (env.GYM_HOSTNAME ? `https://${env.GYM_HOSTNAME}` : undefined);
    if (!origin) throw new Error('Set GYM_HOSTNAME or PUBLIC_ORIGIN');
    io.stdout(setupLink(origin, env.SETUP_TOKEN));
    return 0;
  } catch (error) { io.stderr(error instanceof Error ? error.message : 'Unable to print setup link'); return 1; }
  } };
}
export const commands: readonly Command[] = [createSetupLinkCommand()];
