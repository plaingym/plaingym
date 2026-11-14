// SPDX-License-Identifier: AGPL-3.0-only
// Capture before teardown: a restart can reset both Docker's OOMKilled flag and the sampled cgroup's counters.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const stateFormat = '{"name":{{json .Name}},"state":{{json .State}},"restarts":{{.RestartCount}},"memoryLimit":{{.HostConfig.Memory}},"sysctls":{{json .HostConfig.Sysctls}}}';

export async function collectDiagnostics({ compose, sampler, since, out }, command) {
  const records = {};
  const capture = async (name, binary, args) => {
    try {
      records[name] = await command(binary, args, { allowFailure: true, cleanup: true, timeout: 15_000 });
    } catch (error) {
      records[name] = { code: null, error: error.message };
    }
    return records[name];
  };
  for (const service of ['app', 'postgres', 'caddy']) {
    const ids = await capture(service + ' IDs', 'docker', [...compose, 'ps', '--all', '--quiet', service]);
    if (ids.code === 0 && ids.out.trim()) {
      // Never inspect Config.Env: it contains the install's credentials.
      await capture(service + ' state', 'docker', ['inspect', '--format',
        stateFormat, ...ids.out.trim().split(/\s+/)]);
    }
    await capture(service + ' logs', 'docker', [...compose, 'logs', '--no-color', '--timestamps', '--tail', '100', service]);
  }
  await capture('sampler state', 'docker', ['inspect', '--format', stateFormat, sampler]);
  await capture('sampler logs', 'docker', ['logs', '--timestamps', '--tail', '100', sampler]);
  const project = compose[compose.indexOf('--project-name') + 1];
  // --until is essential: an unbounded events command would wait forever for new events.
  await capture('container events', 'docker', ['events', '--since', since, '--until', new Date().toISOString(),
    '--filter', 'type=container', '--filter', 'label=com.docker.compose.project=' + project,
    ...['oom', 'die', 'restart', 'start', 'kill'].flatMap((event) => ['--filter', 'event=' + event]),
    '--format', '{{json .}}']);
  // util-linux accepts @epoch seconds; an ISO timestamp ending in Z is not accepted by dmesg.
  await capture('host kernel', 'sudo', ['-n', 'dmesg', '--time-format', 'iso', '--since', '@' + Math.floor(Date.parse(since) / 1000)]);
  await writeFile(join(out, 'diagnostics.json'), JSON.stringify(records, null, 2) + '\n');
  return records;
}

export function formatDiagnostics(records) {
  return 'Memory failure diagnostics (captured before teardown):\n' + Object.entries(records).map(([name, result]) =>
    `--- ${name} (exit ${result.code ?? 'unknown'}${result.timedOut ? ', timed out' : ''}) ---\n${result.out ?? ''}${result.error ?? ''}`
  ).join('\n');
}
