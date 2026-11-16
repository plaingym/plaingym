// SPDX-License-Identifier: AGPL-3.0-only
// Only retain a fixed process role, never command arguments or environment (which may contain credentials).
export function processRole(command) {
  const args = command.split('\0').filter(Boolean);
  // Postgres backends and workers replace their command line with a title such as `postgres: checkpointer`.
  if (/^postgres:/.test(args[0] ?? '')) return 'postgres';
  const binary = args[0]?.split('/').at(-1);
  if (binary === 'node') {
    if (args.some(arg => /(?:^|\/)maintenance\.mjs$/.test(arg))) return 'maintenance';
    const server = args.findIndex(arg => /(?:^|\/)server\.mjs$/.test(arg));
    // gym-app invokes server.mjs with a command; the HTTP server has no arguments after the entry path.
    if (server !== -1) return server === args.length - 1 ? 'server' : 'cli';
    if (args.some(arg => /(?:^|\/)cli\.mjs$/.test(arg))) return 'cli';
    return 'other-node';
  }
  return ['pg_dump', 'age', 'caddy', 'postgres'].includes(binary) ? binary : 'other';
}

export function processMemory(rollup) {
  const field = (key, required = false) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(rollup);
    if (!match && required) throw new Error(`Missing ${key} in smaps_rollup`);
    return match ? Number(match[1]) * 1024 : null;
  };
  return { rss: field('Rss', true), pss: field('Pss', true),
    pssAnon: field('Pss_Anon'), pssFile: field('Pss_File'), pssShmem: field('Pss_Shmem'),
    privateClean: field('Private_Clean'), privateDirty: field('Private_Dirty'),
    sharedClean: field('Shared_Clean'), sharedDirty: field('Shared_Dirty') };
}
