// SPDX-License-Identifier: AGPL-3.0-only
// The memory budget of the shipped stack and the judgement of one sampled run against it.
// Pure functions: run.mjs feeds them what the sampler recorded, and budget.test.mjs feeds them synthetic runs.

const MiB = 1024 ** 2;
export const sampleIntervalMs = 500;

/**
 * The budget, in MiB. `limits` and `nodeOldSpaceMiB` are the shipped policy (deploy/compose.yaml). The ceilings are
 * measured in CI on 2026-11-16, with about 20% headroom for app and stack variation. Process memory counts the app's
 * PSS (Node and every child in its cgroup, including maintenance.mjs and pg_dump), Postgres' PSS and Caddy's RSS.
 * Shared program pages are apportioned rather than counted in full for both Node processes.
 * Raise a ceiling only with a new measurement and a matching line in the deployment notes
 * (Resource Budget), never to silence a failure.
 */
export const budget = {
  limits: { app: 512, postgres: 384, caddy: 128 },
  nodeOldSpaceMiB: 256,
  // Largest of the baseline and two branch CI runs: app PSS peak 369.3, warm idle 244.3;
  // stack peak 620.2, warm idle 499.6 MiB. Postgres PSS peak 228.8, Caddy RSS peak 64.0 MiB.
  // See README for the calibration runs; app and stack ceilings retain about 20% headroom over these maxima.
  capped: {
    appPeakMiB: 450, appWarmIdleMiB: 300, postgresPeakMiB: 250, caddyPeakMiB: 70,
    stackIdleMiB: 600, stackPeakMiB: 750,
  },
  // Uncapped CI maxima: app PSS peak 511.2, Postgres PSS 210.0, Caddy RSS 64.2, stack peak 758.4 MiB.
  uncapped: { appPeakMiB: 620, postgresPeakMiB: 250, caddyPeakMiB: 70, stackPeakMiB: 930 },
  // Sampler evidence: a run the sampler missed proves nothing.
  minCoverage: 0.9,
  maxGapMs: 3000,
  minSamples: 60,
};

const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => (values.length ? sum(values) / values.length : null);
const mib = (bytes) => Math.round((bytes / MiB) * 10) / 10;
const processMetric = (name) => name === 'caddy' ? 'RSS' : 'PSS';
export const processBytes = (service, name) => {
  const bytes = name === 'caddy' ? service.rss : service.pss;
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`Missing or invalid ${name} ${processMetric(name)} sample`);
  return bytes;
};

/** Prefer the sampler's clock; host-clock bounds are only a fallback for missing marks. */
export function resolveMarks(fallback, recorded) {
  const marks = { ...fallback, ...recorded };
  return { marks, clock: {
    samples: 'sampler-container',
    marks: Object.fromEntries(Object.keys(marks).map((name) => [name, Object.hasOwn(recorded, name) ? 'sampler-container' : 'runner-host'])),
    note: 'Runner-host fallback marks may differ from the sampler-container clock on Docker Desktop.',
  } };
}

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
      processMetric: processMetric(name),
      peakProcessBytes: Math.max(0, ...all.map((s) => processBytes(s, name))),
      freshIdleBytes: mean(fresh.map((sample) => processBytes(sample.services[name], name))),
      warmIdleBytes: mean(warm.map((sample) => processBytes(sample.services[name], name))),
      // Each role's peak is a simultaneous sum, never a sum of independent PID peaks.
      processes: processBreakdown(all, warm.map(sample => sample.services[name])),
      peakRssBytes: Math.max(0, ...all.map((s) => s.rss)),
      peakCgroupBytes: Math.max(0, ...all.map((s) => Math.max(s.current, s.peak ?? 0))),
      peakSocketBytes: Math.max(0, ...all.map((s) => s.stat?.sock ?? 0)),
      peakAnonBytes: Math.max(0, ...all.map((s) => s.stat?.anon ?? 0)),
      peakFileBytes: Math.max(0, ...all.map((s) => s.stat?.file ?? 0)),
      maxBytes: last.max === 'max' ? null : Number(last.max),
      swapPeakBytes: Math.max(0, ...all.map((s) => s.swap)),
      // Restarts can replace the cgroup and reset its counters before the last sample.
      oomEvents: Math.max(0, ...samples.map((s) => s.services[name].events.oom - first.events.oom)),
      oomKills: Math.max(0, ...samples.map((s) => s.services[name].events.oom_kill - first.events.oom_kill)),
    }];
  }));
  const stack = (pick) => sum(names.map((name) => pick(name)));
  const processSum = (list) => Math.max(0, ...list.map((sample) => sum(names.map((n) => processBytes(sample.services[n], n)))));
  const times = samples.map((sample) => sample.at);
  const gaps = times.slice(1).map((at, index) => at - times[index]);
  const spanMs = times.at(-1) - times[0];
  return {
    services,
    autoUpdateCheck: Number.isFinite(marks.autoUpdateCheckStart) && Number.isFinite(marks.autoUpdateCheckEnd) ? {
      baselineStackProcessBytes: processSum(within(samples, marks.autoUpdateCheckStart - 2000, marks.autoUpdateCheckStart)),
      peakStackProcessBytes: processSum(within(samples, marks.autoUpdateCheckStart, marks.autoUpdateCheckEnd)),
      samples: within(samples, marks.autoUpdateCheckStart, marks.autoUpdateCheckEnd).length,
    } : null,
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

function processBreakdown(run, warm) {
  const roles = [...new Set(run.flatMap(service => (service.processes ?? []).map(p => p.role)))];
  const roleBytes = (service, role) => sum((service.processes ?? []).filter(p => p.role === role).map(p => p.pss));
  const peak = run.reduce((best, service) => !best || service.pss > best.pss ? service : best, null);
  return { atServicePssPeak: peak?.processes ?? [], roles: Object.fromEntries(roles.map(role => [role, {
    peakPssBytes: Math.max(0, ...run.map(service => roleBytes(service, role))),
    warmIdlePssBytes: mean(warm.map(service => roleBytes(service, role))),
  }])) };
}

/** Reasons the samples are too thin to judge the run: they say nothing about memory itself. */
function evidenceViolations({ coverage }) {
  const bad = [];
  if (coverage.samples < budget.minSamples) bad.push(`sampler recorded ${coverage.samples} samples, fewer than ${budget.minSamples}`);
  if (coverage.ratio < budget.minCoverage) bad.push(`sampler coverage ${(coverage.ratio * 100).toFixed(0)}% is below ${budget.minCoverage * 100}%`);
  if (coverage.maxGapMs > budget.maxGapMs) bad.push(`sampler gap of ${coverage.maxGapMs} ms exceeds ${budget.maxGapMs} ms`);
  if (!coverage.freshSamples) bad.push('no samples in the fresh-idle window');
  if (!coverage.warmSamples) bad.push('no samples in the warm-idle window');
  return bad;
}

/**
 * The reasons a run fails the budget, empty when it passes.
 * `mode` is capped (the shipped compose limits) or uncapped (no memory limits and no V8 heap flag, to see what the
 * stack would use on a big host); `facts` is what Docker reported about the containers once the run was over.
 */
export function evaluate(summary, { mode, facts = {} }) {
  // Evidence first: without enough samples nothing below means anything.
  const bad = evidenceViolations(summary);
  const { services, stack } = summary;
  const limit = (name, label, bytes, maxMiB) => { if (bytes > maxMiB * MiB) bad.push(`${label} ${mib(bytes)} MiB exceeds ${maxMiB} MiB`); };

  // Out-of-memory kills fail every run, capped or not.
  for (const [name, service] of Object.entries(services)) {
    if (service.oomEvents > 0 || service.oomKills > 0) bad.push(`${name} hit its memory limit (${service.oomEvents} oom, ${service.oomKills} oom_kill)`);
  }
  if (summary.hostOomKills > 0) bad.push(`the kernel killed ${summary.hostOomKills} process(es) for memory (global counter; see diagnostics for the OOM constraint)`);
  bad.push(...containerViolations(facts));

  if (mode === 'capped') {
    for (const [name, mibLimit] of Object.entries(budget.limits)) {
      if (services[name].maxBytes !== mibLimit * MiB) bad.push(`${name} memory limit is ${services[name].maxBytes === null ? 'unset' : mib(services[name].maxBytes) + ' MiB'}, expected ${mibLimit} MiB`);
    }
    if (facts.nodeOptions !== undefined && !String(facts.nodeOptions).includes(`--max-old-space-size=${budget.nodeOldSpaceMiB}`)) bad.push('V8 old-space cap is not the shipped 256 MiB');
    limit('app', 'app PSS peak', services.app.peakProcessBytes, budget.capped.appPeakMiB);
    limit('app', 'app PSS at warm idle', services.app.warmIdleBytes ?? 0, budget.capped.appWarmIdleMiB);
    limit('postgres', 'Postgres PSS peak', services.postgres.peakProcessBytes, budget.capped.postgresPeakMiB);
    limit('caddy', 'Caddy RSS peak', services.caddy.peakProcessBytes, budget.capped.caddyPeakMiB);
    limit('stack', 'whole-stack process memory at warm idle', stack.warmIdleBytes ?? 0, budget.capped.stackIdleMiB);
    limit('stack', 'whole-stack process memory peak', stack.peakProcessBytes, budget.capped.stackPeakMiB);
  } else {
    // Uncapped: no memory limits and no heap flag. Recorded for comparison, and held to its own measured ceilings.
    const ceiling = budget.uncapped;
    limit('app', 'app uncapped PSS peak', services.app.peakProcessBytes, ceiling.appPeakMiB);
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
 * exits 2, otherwise 1. Bookkeeping failures cannot hide a budget violation from a completed workload's summary, but
 * the thin evidence one can leave behind (a dead sampler) is not a budget violation: that run exits 1.
 */
export function assessRun(summary, { mode, facts, failures = [], bookkeepingFailures = [] }) {
  const killed = Object.values(facts.containers).some((state) => state.oomKilled || state.restarts > 0 || state.exitCode === 137)
    || (summary && (summary.hostOomKills > 0 || Object.values(summary.services).some((service) => service.oomEvents > 0 || service.oomKills > 0)));
  // evaluate() reports the container facts itself; without samples, report them here so an exit 2 always says why.
  const violations = summary ? evaluate(summary, { mode, facts }) : containerViolations(facts);
  for (const [name, state] of Object.entries(facts.containers)) if (state.exitCode === 137) violations.push(`${name} container exited 137 (killed)`);
  const unproven = summary && bookkeepingFailures.length ? evidenceViolations(summary).length : 0;
  const exitCode = killed ? 2 : failures.length ? 1 : summary && violations.length > unproven ? 2 : !summary || bookkeepingFailures.length ? 1 : 0;
  violations.push(...failures, ...bookkeepingFailures);
  return { violations, exitCode };
}

export function report(summary, violations, mode) {
  const row = (name, s) => `${name.padEnd(9)} peak ${String(mib(s.peakProcessBytes)).padStart(6)} MiB   fresh idle ${String(s.freshIdleBytes === null ? '-' : mib(s.freshIdleBytes)).padStart(6)}   warm idle ${String(s.warmIdleBytes === null ? '-' : mib(s.warmIdleBytes)).padStart(6)}   cgroup peak ${String(mib(s.peakCgroupBytes)).padStart(6)}   swap peak ${String(mib(s.swapPeakBytes ?? 0)).padStart(5)}`;
  const lines = [`Memory run (${mode}; app/Postgres PSS, Caddy RSS; stack is their simultaneous sum)`,
    ...Object.entries(summary.services).map(([name, s]) => row(name, s)),
    row('stack', { ...summary.stack, swapPeakBytes: 0 }),
    `sampler   ${summary.coverage.samples} samples over ${Math.round(summary.coverage.spanMs / 1000)} s, coverage ${(summary.coverage.ratio * 100).toFixed(0)}%, longest gap ${summary.coverage.maxGapMs} ms`,
    `OOM       global ${summary.hostOomKills}; ${Object.entries(summary.services).map(([n, s]) => `${n} ${s.oomEvents}/${s.oomKills}`).join(', ')} (oom/oom_kill)`];
  lines.push(violations.length ? 'FAIL:\n  - ' + violations.join('\n  - ') : 'PASS: within the budget');
  return lines.join('\n');
}
