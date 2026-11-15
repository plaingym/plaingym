// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** A detached group lets a timeout stop Docker clients before the caller removes their project. */
export function runSmoke(args, timeout = 900_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'inherit', windowsHide: true });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      try {
        if (process.platform === 'win32')
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000, stdio: 'ignore', windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') { clearTimeout(timer); reject(error); }
      }
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (expired) reject(new Error('Compatibility smoke timed out; its process group was stopped'));
      else if (code !== 0) reject(new Error(`Compatibility smoke exited ${code ?? signal}`));
      else resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runSmoke(process.argv.slice(2));
