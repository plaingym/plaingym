// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
export interface ProcessLease { pid: number; started: string | null; }
export async function processStart(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}
export async function processAlive(owner: ProcessLease): Promise<boolean> {
  try { process.kill(owner.pid, 0); return owner.started === await processStart(owner.pid); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
