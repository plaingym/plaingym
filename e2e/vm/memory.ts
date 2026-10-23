// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { checked, ssh, compose, quote, sql, type Config, type Target } from './host.js';

export interface Sample {
  at: number; hostOomKills: number;
  host: { MemTotal: number; MemAvailable: number; SwapTotal: number; SwapFree: number };
  containers: Record<string, { current: number; peak: number; max: string; swap: number; events: Record<string, number>; initialRestarts: number }>;
}
export async function startMemory(target: Target) {
  const source = await readFile(new URL('./memory.py', import.meta.url), 'utf8');
  await checked(target, "umask 077\ncat >/root/plaingym-qa/memory.py <<'QA_MEMORY'\n" + source +
    "\nQA_MEMORY\nnohup python3 /root/plaingym-qa/memory.py >/root/plaingym-qa/memory.jsonl 2>/root/plaingym-qa/memory-error.log </dev/null &\necho $! >/root/plaingym-qa/memory.pid\nattempt=0\nuntil [ -s /root/plaingym-qa/memory.jsonl ]; do\n  kill -0 \"$(cat /root/plaingym-qa/memory.pid)\"\n  attempt=$((attempt + 1)); [ \"$attempt\" -lt 60 ] || exit 1\n  sleep 1\ndone\n");
}
export async function endMemory(target: Target, config: Config, busyStart?: number) {
  const output = await checked(target, 'kill "$(cat /root/plaingym-qa/memory.pid)"\ncat /root/plaingym-qa/memory.jsonl\n');
  await writeFile(resolve(config.artifacts, 'memory.jsonl'), output, { mode: 0o600 });
  const samples = output.trim().split('\n').map((line) => JSON.parse(line) as Sample);
  if(samples.length < 4) throw new Error('Memory sampler did not produce enough evidence');
  const first = samples[0], last = samples.at(-1)!;
  const limits = { app: 512, postgres: 384, caddy: 128 };
  const violations: string[] = [];
  for(const [service, mib] of Object.entries(limits)) {
    if(Number(last.containers[service].max) !== mib * 1024 ** 2) violations.push(service + ' memory cap changed');
    if(samples.some((sample) => sample.containers[service].events.oom_kill > first.containers[service].events.oom_kill ||
      sample.containers[service].events.oom > first.containers[service].events.oom)) violations.push(service + ' cgroup OOM');
  }
  if(last.hostOomKills > first.hostOomKills) violations.push('host OOM kill');
  // mkswap reserves a header page from the installer's 1 GiB file.
  if(first.host.SwapTotal < 1000 * 1024 ** 2) violations.push('less than a 1 GiB swapfile worth of usable swap');
  if(!config.localFixture && (first.host.MemTotal > 1100 * 1024 ** 2 || first.host.MemTotal < 800 * 1024 ** 2)) violations.push('memory acceptance requires a real 1 GB VM');
  const peaks = Object.fromEntries(Object.keys(limits).map((name) => [name, Math.max(...samples.map((s) => s.containers[name].peak))]));
  const totalPeak = Math.max(...samples.map((s) => Object.values(s.containers).reduce((sum, c) => sum + c.current, 0)));
  const idleSamples = busyStart ? samples.filter((s) => s.at < busyStart && s.at >= busyStart - 10) : [];
  const idleStackBytes = idleSamples.length ? Math.round(idleSamples.reduce((sum, s) => sum + Object.values(s.containers).reduce((n, c) => n + c.current, 0), 0) / idleSamples.length) : null;
  if(totalPeak > 600 * 1024 ** 2) violations.push('sampled full-stack peak exceeds proposed 600 MiB target');
  const states = await checked(target, compose("ps -q") + " | xargs docker inspect --format '{{index .Config.Labels \"com.docker.compose.service\"}} {{.State.OOMKilled}} {{.RestartCount}}'");
  if(states.split('\n').some((line) => {
    const [service, killed, restarts] = line.split(' ');
    return killed !== 'false' || !first.containers[service] || Number(restarts) > first.containers[service].initialRestarts;
  })) violations.push('container restarted or was OOM killed during measurement');
  const policy = await checked(target, compose("exec -T app node -e " + quote("console.log(JSON.stringify({node:process.version,options:process.env.NODE_OPTIONS}))")));
  if(!policy.includes('--max-old-space-size=256')) violations.push('V8 old-space policy changed');
  const report = {
    localOnly: Boolean(config.localFixture), seconds: last.at - first.at, samples: samples.length,
    host: first.host, containerPeakBytes: peaks, sampledStackPeakBytes: totalPeak, idleStackBytes, hostOomDelta: last.hostOomKills - first.hostOomKills,
    states, policy, violations
  };
  await writeFile(resolve(config.artifacts, 'memory-summary.json'), JSON.stringify(report, null, 2));
  return report;
}
export async function backupLoad(target: Target, artifacts?: string) {
  // QA workload injection only. The owner flow already proved an unattended
  // scheduled backup; no CLI is used to configure a gym or perform its restore.
  const result = await ssh(target, compose('exec -T app node /app/maintenance.mjs snapshot') + '\n');
  if(result.code !== 0) {
    if(artifacts) await writeFile(resolve(artifacts, 'backup-workload-error.log'), result.out, { mode: 0o600 });
    throw new Error('Concurrent backup workload failed; see private backup-workload-error.log');
  }
  return JSON.parse(await checked(target, sql("SELECT json_build_object('startedAt',extract(epoch from started_at)*1000,'completedAt',extract(epoch from completed_at)*1000) FROM backup_runs WHERE kind='manual' AND status='succeeded' ORDER BY started_at DESC LIMIT 1"))) as { startedAt: number; completedAt: number };
}
export async function prepareArgon(target: Target) {
  const extract = "const fs=require('node:fs'); const map=JSON.parse(fs.readFileSync('/app/server.mjs.map','utf8')); const i=map.sources.findIndex(s=>s.endsWith('/infra/auth/password.ts')); if(i<0) throw new Error('Missing deployed adapter source'); console.log(JSON.stringify(map.sourcesContent[i]));";
  const deployed = JSON.parse(await checked(target, compose('exec -T app node -e ' + quote(extract)))) as string;
  return { base64: Buffer.from(stripTypeScriptTypes(deployed, { mode: 'strip' })).toString('base64'), sha256: createHash('sha256').update(deployed).digest('hex') };
}
export async function argonLoad(target: Target, module: { base64: string; sha256: string }) {
  const source = (await readFile(new URL('./argon.mjs', import.meta.url), 'utf8'))
    .replace('DEPLOYED_PASSWORD_ADAPTER_BASE64', module.base64).replace('DEPLOYED_PASSWORD_ADAPTER_SHA256', module.sha256);
  const output = await checked(target, [
    'set -eu',
    'qa_app_id=$(' + compose('ps -q app') + ')',
    'qa_old_nano=$(docker inspect --format \'{{.HostConfig.NanoCpus}}\' "$qa_app_id")',
    'qa_old_cpus=$(awk "BEGIN {print $qa_old_nano / 1000000000}")',
    'trap \'docker update --cpus "$qa_old_cpus" "$qa_app_id" >/dev/null\' EXIT',
    // Finish the bounded workload and restore the original quota even if the
    // controlling client disconnects. No Compose/environment file is edited.
    "trap '' HUP",
    'docker update --cpus 1 "$qa_app_id" >/dev/null',
    compose('exec -T app nice -n 10 timeout --signal=TERM 300s node --input-type=module') + " <<'QA_ARGON'",
    source, 'QA_ARGON', '',
  ].join('\n'));
  const line = output.split('\n').find((line) => line.startsWith('{'));
  if(!line) throw new Error('The deployed adapter benchmark did not return metrics');
  return JSON.parse(line) as { startedAt: number; completedAt: number; requests: number; peakActive: number; peakQueued: number };
}
