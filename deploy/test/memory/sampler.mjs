// SPDX-License-Identifier: AGPL-3.0-only
// Samples the stack's real container cgroups and processes every 500 ms. Run it in a short-lived privileged container
// that shares the host's process and cgroup namespaces (run.mjs does), so it reads the same files on a CI runner and on
// Docker Desktop: per service the cgroup's memory.current/peak/max/swap/events, the RSS of its processes and the PSS
// (shared pages divided among their users; summing RSS would count Postgres' shared buffers once per backend).
//
// SERVICES is a JSON object of service name to full container ID; SAMPLES_OUT is the JSON-lines file to append to.
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';

const services = JSON.parse(process.env.SERVICES ?? '{}');
const out = process.env.SAMPLES_OUT ?? '/out/samples.jsonl';
const interval = 500;
const read = (path) => readFileSync(path, 'utf8');
const kib = (text, key) => { const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text); return match ? Number(match[1]) * 1024 : 0; };

/** The cgroup directory of a container: the one a process of that container (found by its ID) lives in. */
function cgroupOf(id) {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const line = read(`/proc/${entry}/cgroup`).split('\n').find((candidate) => candidate.startsWith('0::') && candidate.includes(id));
      if (line) return '/sys/fs/cgroup' + line.slice(3);
    } catch { /* the process ended */ }
  }
  throw new Error('No cgroup found for container ' + id.slice(0, 12));
}
const groups = Object.fromEntries(Object.entries(services).map(([name, id]) => [name, cgroupOf(id)]));
const keyValues = (text) => Object.fromEntries(text.trim().split('\n').map((line) => { const [key, value] = line.split(' '); return [key, Number(value)]; }));

function sampleService(group) {
  let rss = 0, pss = 0, procs = 0;
  for (const pid of read(`${group}/cgroup.procs`).split('\n').filter(Boolean)) {
    try {
      const rollup = read(`/proc/${pid}/smaps_rollup`);
      rss += kib(rollup, 'Rss'); pss += kib(rollup, 'Pss'); procs += 1;
    } catch { /* ended between the listing and the read */ }
  }
  const max = read(`${group}/memory.max`).trim();
  let peak = null;
  try { peak = Number(read(`${group}/memory.peak`)); } catch { /* older kernels have no memory.peak */ }
  return { current: Number(read(`${group}/memory.current`)), peak, max, swap: Number(read(`${group}/memory.swap.current`)),
    events: keyValues(read(`${group}/memory.events`)), rss, pss, procs };
}
const hostOomKills = () => Number((/^oom_kill (\d+)/m.exec(read('/proc/vmstat')) ?? [])[1] ?? 0);

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; });
let next = Date.now();
while (!stopping) {
  const at = Date.now();
  try {
    appendFileSync(out, JSON.stringify({ at, hostOomKills: hostOomKills(),
      services: Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, sampleService(group)])) }) + '\n');
  } catch (error) {
    // A container that is gone ends the run; anything else is worth a line in the container log.
    console.error(String(error));
    if (error.code === 'ENOENT') break;
  }
  next += interval;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - Date.now())));
}
