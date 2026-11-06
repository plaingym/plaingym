// SPDX-License-Identifier: AGPL-3.0-only
export interface Sample {
  at: number; hostOomKills: number;
  host: { MemTotal: number; MemAvailable: number; SwapTotal: number; SwapFree: number };
  containers: Record<string, { current: number; anon: number; file: number; peak: number; max: string; swap: number; events: Record<string, number>; initialRestarts: number }>;
}

/**
 * Cgroup totals include `file`: page cache, plus shared memory such as Postgres's shared_buffers, which isn't reclaimable.
 * The idle target measures `anon`, which excludes both. A measured run (`busyStart` set) with no idle samples fails it.
 */
export function summarizeMemory(samples: Sample[], busyStart?: number) {
  const names = ['app', 'postgres', 'caddy'];
  const containerPeakBytes = Object.fromEntries(names.map((name) => [name, Math.max(...samples.map((s) => s.containers[name].peak))]));
  const stack = (sample: Sample, field: 'current' | 'anon' | 'file') => names.reduce((sum, name) => sum + sample.containers[name][field], 0);
  const sampledStackPeakBytes = Math.max(...samples.map((sample) => stack(sample, 'current')));
  const idle = busyStart === undefined ? [] : samples.filter((s) => s.at < busyStart && s.at >= busyStart - 10);
  const average = (field: 'current' | 'anon' | 'file') => idle.length ? Math.round(idle.reduce((sum, s) => sum + stack(s, field), 0) / idle.length) : null;
  const idleStackBytes = average('anon');
  const violations: string[] = [];
  if (busyStart !== undefined && idleStackBytes === null) violations.push('no samples in the 10 seconds before load, so the idle target was not measured');
  if (idleStackBytes !== null && idleStackBytes > 250 * 1024 ** 2) violations.push('sampled full-stack idle anonymous memory exceeds proposed 250 MiB target');
  if (sampledStackPeakBytes > 600 * 1024 ** 2) violations.push('sampled full-stack peak exceeds proposed 600 MiB target');
  return { containerPeakBytes, sampledStackPeakBytes, idleStackBytes, idleStackCurrentBytes: average('current'),
    idleStackFileBytes: average('file'), idleMetric: 'memory.stat anon', violations };
}
