// SPDX-License-Identifier: AGPL-3.0-only
// Executed inside the shipped app container, without changing its login limits.
// The runner extracts this module from the deployed source map and strips its
// types on the maintainer machine, before resource sampling. Compiler/parser
// overhead must not be mistaken for the application's password working set.
const moduleBase64 = 'DEPLOYED_PASSWORD_ADAPTER_BASE64';
const { passwordAdapter } = await import('data:text/javascript;base64,' + moduleBase64);
const startedAt = Date.now();
let peakActive = 0, peakQueued = 0;
const samples = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
  const password = 'vm-argon-benchmark-Å-' + i;
  const start = performance.now();
  const pending = passwordAdapter.hash(password);
  peakActive = Math.max(peakActive, passwordAdapter.active);
  peakQueued = Math.max(peakQueued, passwordAdapter.queued);
  const hash = await pending;
  if (!hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')) throw new Error('Unexpected PHC policy');
  if (!await passwordAdapter.verify({ hash, password: password.normalize('NFKD') })) throw new Error('Password normalization failed');
  return performance.now() - start;
}));
if (peakActive !== 2 || peakQueued < 1) throw new Error('The deployed adapter did not bound its burst to two active slots');
console.log(JSON.stringify({ startedAt, completedAt: Date.now(), requests: 20, latenciesMs: samples,
  peakActive, peakQueued, peakRssKiB: process.resourceUsage().maxRSS, node: process.version,
  phc: 'm=19456,t=2,p=1', normalization: 'NFKC', source: 'shipped server.mjs.map', sourceSha256: 'DEPLOYED_PASSWORD_ADAPTER_SHA256', process: 'separate QA workload inside app cgroup' }));
