// SPDX-License-Identifier: AGPL-3.0-only
import { RestoreGate } from './restore.gate.js';

const gate = new RestoreGate(process.argv[2]!);
let release: (() => void) | undefined;
process.on('message', (message: string) => {
  void (async () => {
    if (message === 'hold') {
      await gate.activity(async () => {
        const finished = new Promise<void>(resolve => { release = resolve; });
        process.send?.('active');
        await finished;
      });
      process.send?.('released');
    } else if (message === 'idle') {
      await gate.activity(async () => undefined);
      process.send?.('idle');
    } else if (message === 'try') {
      await gate.activity(async () => { process.send?.('admitted'); });
    } else if (message === 'release') release?.();
  })().catch((error: unknown) => {
    if (error instanceof Error && error.message === 'Restore in progress') process.send?.('refused');
    else { process.stderr.write(String(error)); process.exit(1); }
  });
});
process.send?.('ready');
// Bound a failed test even if its parent cannot run cleanup.
setTimeout(() => process.exit(1), 15_000).unref();
