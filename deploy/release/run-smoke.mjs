// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function defaultStopGroup(child) {
  if (process.platform === 'win32')
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000, stdio: 'ignore', windowsHide: true });
  else process.kill(-child.pid, 'SIGKILL');
}

/** A detached group lets a timeout stop Docker clients before the caller removes their project. */
export function runSmoke(args, timeout = 900_000, { killWaitMs = 3_000, stopGroup = defaultStopGroup, signals = process } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'inherit', windowsHide: true });
    let timeoutTimer, killWaitTimer, stopCause, killError;
    let stopping = false, settled = false;
    const onSigint = () => stop('SIGINT');
    const onSigterm = () => stop('SIGTERM');
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killWaitTimer);
      signals.off('SIGINT', onSigint);
      signals.off('SIGTERM', onSigterm);
    };
    const settle = action => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const settleStopped = () => {
      const what = stopCause === 'timeout' ? 'timed out' : `interrupted by ${stopCause}`;
      const group = killError ? 'could not be stopped' : 'was stopped';
      settle(() => reject(new Error(`Compatibility smoke ${what}; its process group ${group}`, killError ? { cause: killError } : undefined)));
    };
    const stop = cause => {
      if (stopping || settled) return;
      stopping = true;
      stopCause = cause;
      try { stopGroup(child); }
      catch (error) { if (error.code !== 'ESRCH') killError = error; }
      killWaitTimer = setTimeout(settleStopped, killWaitMs);
    };
    timeoutTimer = setTimeout(() => stop('timeout'), timeout);
    signals.on('SIGINT', onSigint);
    signals.on('SIGTERM', onSigterm);
    child.once('error', error => settle(() => reject(error)));
    child.once('exit', (code, signal) => {
      if (settled) return;
      if (stopping) settleStopped();
      else if (code !== 0) settle(() => reject(new Error(`Compatibility smoke exited ${code ?? signal}`)));
      else settle(resolve);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runSmoke(process.argv.slice(2));
