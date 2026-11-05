// SPDX-License-Identifier: AGPL-3.0-only
// The memory budget of the shipped stack and the judgement of one sampled run against it.
// Pure functions: run.mjs feeds them what the sampler recorded, and budget.test.mjs feeds them synthetic runs.

const MiB = 1024 ** 2;
export const sampleIntervalMs = 500;

/**
 * The budget, in MiB. `limits` and `nodeOldSpaceMiB` are the shipped policy (deploy/compose.yaml). The ceilings are
 * measured: the largest of two full runs on 2026-11-03 (Docker Desktop, 16 CPUs; the figures beside each) plus about
 * 20% for CI machines, which differ run to run. Process memory counts the app's RSS (Node and any child in its cgroup,
 * such as the backup's `maintenance.mjs` and `pg_dump`; RSS includes about 55 MiB of mapped program files), Postgres'
 * PSS and Caddy's RSS. Raise a ceiling only with a new measurement and a matching line in the deployment notes
 * (Resource Budget), never to silence a failure.
 */
export const budget = {
  limits: { app: 512, postgres: 384, caddy: 128 },
  nodeOldSpaceMiB: 256,
  // Capped (the shipped limits). Measured: app peak 422-444, app warm idle 287-303, Postgres peak 194-210,
  // Caddy peak 54, stack warm idle 519-537, stack peak 662-680.
  capped: {
    appPeakMiB: 520, appWarmIdleMiB: 360, postgresPeakMiB: 250, caddyPeakMiB: 70,
    stackIdleMiB: 640, stackPeakMiB: 820,
  },
  // Uncapped (no limits, no heap flag). Measured: app peak 629, Postgres peak 208, Caddy peak 55, stack peak 860.
  uncapped: { appPeakMiB: 760, postgresPeakMiB: 250, caddyPeakMiB: 70, stackPeakMiB: 1040 },
  // Sampler evidence: a run the sampler missed proves nothing.
  minCoverage: 0.9,
  maxGapMs: 3000,
  minSamples: 60,
};

const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => (values.length ? sum(values) / values.length : null);
const mib = (bytes) => Math.round((bytes / MiB) * 10) / 10;
export const processBytes = (service, name) => (name === 'postgres' ? service.pss : service.rss);

function within(samples, from, to) {
  return samples.filter((sample) => sample.at >= from && sample.at <= to);
}

/**
 * Reduce a sampled run to the figures the budget talks about.
 * `marks` maps phase names to epoch milliseconds: ready, loadStart, loadEnd, settled.
 */
export function summarize(samples, marks) {
  if (samples.length === 0) throw new Error('No samples');
  const names = Object.keys(samples[0].services);
  const run = within(samples, marks.ready, marks.settled);
  const fresh = within(samples, marks.ready, marks.ready + 10_000);
  const warm = within(samples, marks.loadEnd + 2000, marks.settled);
  const services = Object.fromEntries(names.map((name) => {
    const all = run.map((sample) => sample.services[name]);
    const last = samples.at(-1).services[name], first = samples[0].services[name];
    return [name, {
      peakProcessBytes: Math.max(0, ...all.map((s) => processBytes(s, name))),
      freshIdleBytes: mean(fresh.map((sample) => processBytes(sample.services[name], name))),
      warmIdleBytes: mean(warm.map((sample) => processBytes(sample.services[name], name))),
      peakRssBytes: Math.max(0, ...all.map((s) => s.rss)),
      peakCgroupBytes: Math.max(0, ...all.map((s) => s.current), last.peak ?? 0),
      maxBytes: last.max === 'max' ? null : Number(last.max),
      swapPeakBytes: Math.max(0, ...all.map((s) => s.swap)),
      oomEvents: Math.max(0, last.events.oom - first.events.oom),
      oomKills: Math.max(0, last.events.oom_kill - first.events.oom_kill),
    }];
  }));
  const stack = (pick) => sum(names.map((name) => pick(name)));
  const processSum = (list) => Math.max(0, ...list.map((sample) => sum(names.map((n) => processBytes(sample.services[n], n)))));
  const times = samples.map((sample) => sample.at);
  const gaps = times.slice(1).map((at, index) => at - times[index]);
  const spanMs = times.at(-1) - times[0];
  return {
    services,
    stack: {
      peakProcessBytes: processSum(run),
      freshIdleBytes: fresh.length ? stack((n) => services[n].freshIdleBytes) : null,
      warmIdleBytes: warm.length ? stack((n) => services[n].warmIdleBytes) : null,
      peakCgroupBytes: Math.max(0, ...run.map((sample) => sum(names.map((n) => sample.services[n].current)))),
    },
    hostOomKills: Math.max(0, samples.at(-1).hostOomKills - samples[0].hostOomKills),
    coverage: {
      samples: samples.length, spanMs, maxGapMs: Math.max(0, ...gaps),
      ratio: spanMs > 0 ? Math.min(1, (samples.length - 1) / (spanMs / sampleIntervalMs)) : 0,
      freshSamples: fresh.length, warmSamples: warm.length,
    },
  };
}

/**
 * The reasons a run fails the budget, empty when it passes.
 * `mode` is capped (the shipped compose limits) or uncapped (no memory limits and no V8 heap flag, to see what the
 * stack would use on a big host); `facts` is what Docker reported about the containers once the run was over.
 */
export function evaluate(summary, { mode, facts = {} }) {
  const bad = [];
  const { services, stack, coverage } = summary;
  const limit = (name, label, bytes, maxMiB) => { if (bytes > maxMiB * MiB) bad.push(`${label} ${mib(bytes)} MiB exceeds ${maxMiB} MiB`); };

  // Evidence first: without enough samples nothing below means anything.
  if (coverage.samples < budget.minSamples) bad.push(`sampler recorded ${coverage.samples} samples, fewer than ${budget.minSamples}`);
  if (coverage.ratio < budget.minCoverage) bad.push(`sampler coverage ${(coverage.ratio * 100).toFixed(0)}% is below ${budget.minCoverage * 100}%`);
  if (coverage.maxGapMs > budget.maxGapMs) bad.push(`sampler gap of ${coverage.maxGapMs} ms exceeds ${budget.maxGapMs} ms`);
  if (!coverage.freshSamples) bad.push('no samples in the fresh-idle window');
  if (!coverage.warmSamples) bad.push('no samples in the warm-idle window');

  // Out-of-memory kills fail every run, capped or not.
  for (const [name, service] of Object.entries(services)) {
    if (service.oomEvents > 0 || service.oomKills > 0) bad.push(`${name} hit its memory limit (${service.oomEvents} oom, ${service.oomKills} oom_kill)`);
  }
  if (summary.hostOomKills > 0) bad.push(`the host killed ${summary.hostOomKills} process(es) for memory`);
  bad.push(...containerViolations(facts));

  if (mode === 'capped') {
    for (const [name, mibLimit] of Object.entries(budget.limits)) {
      if (services[name].maxBytes !== mibLimit * MiB) bad.push(`${name} memory limit is ${services[name].maxBytes === null ? 'unset' : mib(services[name].maxBytes) + ' MiB'}, expected ${mibLimit} MiB`);
    }
    if (facts.nodeOptions !== undefined && !String(facts.nodeOptions).includes(`--max-old-space-size=${budget.nodeOldSpaceMiB}`)) bad.push('V8 old-space cap is not the shipped 256 MiB');
    limit('app', 'app RSS peak', services.app.peakProcessBytes, budget.capped.appPeakMiB);
    limit('app', 'app RSS at warm idle', services.app.warmIdleBytes ?? 0, budget.capped.appWarmIdleMiB);
    limit('postgres', 'Postgres PSS peak', services.postgres.peakProcessBytes, budget.capped.postgresPeakMiB);
    limit('caddy', 'Caddy RSS peak', services.caddy.peakProcessBytes, budget.capped.caddyPeakMiB);
    limit('stack', 'whole-stack process memory at warm idle', stack.warmIdleBytes ?? 0, budget.capped.stackIdleMiB);
    limit('stack', 'whole-stack process memory peak', stack.peakProcessBytes, budget.capped.stackPeakMiB);
  } else {
    // Uncapped: no memory limits and no heap flag. Recorded for comparison, and held to its own measured ceilings.
    const ceiling = budget.uncapped;
    limit('app', 'app uncapped RSS peak', services.app.peakProcessBytes, ceiling.appPeakMiB);
    limit('postgres', 'Postgres uncapped PSS peak', services.postgres.peakProcessBytes, ceiling.postgresPeakMiB);
    limit('caddy', 'Caddy uncapped RSS peak', services.caddy.peakProcessBytes, ceiling.caddyPeakMiB);
    limit('stack', 'uncapped whole-stack process memory peak', stack.peakProcessBytes, ceiling.stackPeakMiB);
  }
  return bad;
}

/** Docker's own kill facts for the stack's containers, as violations. */
function containerViolations(facts) {
  const bad = [];
  for (const [name, state] of Object.entries(facts.containers ?? {})) {
    if (state.oomKilled) bad.push(`${name} container was OOM killed`);
    if (state.restarts > 0) bad.push(`${name} container restarted ${state.restarts} time(s)`);
  }
  return bad;
}

/**
 * Judges a whole run, including one whose workload failed (`failures`) or whose samples are missing (`summary` null).
 * A broken workload proves a memory failure only when Docker or the samples show a kill, OOM or restart: then the run
 * exits 2, otherwise 1 (the harness could not run). A clean workload exits 2 on any violation and 0 without one.
 */
export function assessRun(summary, { mode, facts, failures }) {
  const killed = Object.values(facts.containers).some((state) => state.oomKilled || state.restarts > 0 || state.exitCode === 137)
    || (summary && (summary.hostOomKills > 0 || Object.values(summary.services).some((service) => service.oomEvents > 0 || service.oomKills > 0)));
  // evaluate() reports the container facts itself; without samples, report them here so an exit 2 always says why.
  const violations = summary ? evaluate(summary, { mode, facts }) : containerViolations(facts);
  for (const [name, state] of Object.entries(facts.containers)) if (state.exitCode === 137) violations.push(`${name} container exited 137 (killed)`);
  if (failures.length) violations.push(...failures);
  return { violations, exitCode: killed ? 2 : failures.length ? 1 : violations.length ? 2 : 0 };
}

export function report(summary, violations, mode) {
  const row = (name, s) => `${name.padEnd(9)} peak ${String(mib(s.peakProcessBytes)).padStart(6)} MiB   fresh idle ${String(s.freshIdleBytes === null ? '-' : mib(s.freshIdleBytes)).padStart(6)}   warm idle ${String(s.warmIdleBytes === null ? '-' : mib(s.warmIdleBytes)).padStart(6)}   cgroup peak ${String(mib(s.peakCgroupBytes)).padStart(6)}   swap peak ${String(mib(s.swapPeakBytes ?? 0)).padStart(5)}`;
  const lines = [`Memory run (${mode})`,
    ...Object.entries(summary.services).map(([name, s]) => row(name, s)),
    row('stack', { ...summary.stack, swapPeakBytes: 0 }),
    `sampler   ${summary.coverage.samples} samples over ${Math.round(summary.coverage.spanMs / 1000)} s, coverage ${(summary.coverage.ratio * 100).toFixed(0)}%, longest gap ${summary.coverage.maxGapMs} ms`,
    `OOM       host ${summary.hostOomKills}; ${Object.entries(summary.services).map(([n, s]) => `${n} ${s.oomEvents}/${s.oomKills}`).join(', ')} (oom/oom_kill)`];
  lines.push(violations.length ? 'FAIL:\n  - ' + violations.join('\n  - ') : 'PASS: within the budget');
  return lines.join('\n');
}
