<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Memory check

The **Memory** workflow (`.github/workflows/memory.yml`) runs a whole self-hosted deployment and
fails when it uses more memory than the budget, or when anything is killed for memory. It runs on
every integration branch and push to `main`, nightly, and on demand.

    node --test deploy/test/memory/budget.test.mjs     # the budget arithmetic, no Docker
    node deploy/test/memory/run.mjs --mode both        # builds committed HEAD, then measures it

`run.mjs` needs Docker with Compose v2.24 or later and cgroup v2. Options: `--mode capped|uncapped|both`,
`--image TAG` (skip the build; `MEMORY_IMAGE` works too), `--out DIR` (default `deploy/test/memory/out`,
ignored by Git) and `--inject-leak`. Exit code 0 means within budget, 2 the budget was exceeded or
something was killed, 1 the harness could not run (never a pass).

## What runs

The shipped `deploy/compose.yaml` (Caddy, app, PostgreSQL with the tuned settings, hardening and memory
limits installs get), laid over by `compose.memory.yaml`: no published port, CPU caps on every service
(app 1, Postgres 1, Caddy 0.5) and an S3-compatible stand-in (versitygw) as the backup bucket. Nothing
about the stack under test changes.

1. **Setup** through the API: owner, gym, packs, and encrypted backups to the stand-in bucket.
2. **Seed**: 100 households with 300 members, a 20-page waiver template and six signatures; a 115 MB
   table, read into `shared_buffers` with `pg_prewarm`, so PostgreSQL is warm and larger than its buffers.
3. **Load for 45 seconds**: 20 concurrent workers over list, health and page routes; six 20-page
   waiver PDFs rendered at once, twice; an encrypted `maintenance.mjs snapshot` (the app's `age`
   encryption and `pg_dump`) started five seconds in; the in-process job worker runs throughout.
4. **Settle** for 12 seconds, to measure warm idle.

The load generator and sampler run in containers of their own (CPU-capped, `nice`, with `timeout`),
and the run is removed afterwards: containers, volumes, network and the image it built.

## What is measured

`sampler.mjs` runs in a privileged container sharing the host's process and cgroup namespaces (so it
reads the same files on a CI runner and on Docker Desktop). Every 500 ms, for each service:

* cgroup `memory.current`, `memory.peak`, `memory.max`, `memory.swap.current` and `memory.events`
  (`oom`, `oom_kill`);
* the **RSS** of the service's processes (app, Caddy; the app's includes `pg_dump` and anything else in
  its cgroup) and their **PSS** (Postgres: summing RSS would count its shared buffers once per backend).

It also records the host's OOM kill counter. After the run Docker's own `OOMKilled` and restart count
for each container are read, plus the job table's status counts.

Two runs: **capped** (the shipped limits: 512 MiB app, 384 MiB Postgres, 128 MiB Caddy, V8 old space
256 MiB) and **uncapped** (no limits and no heap flag, as on a big host). The capped run is held to the
budget. The uncapped run is held to its own measured ceilings (table below), and comparing it with the
capped run shows whether the limits are doing the work of keeping the stack small.

## The budget

`budget.mjs` is the one place the figures live; `budget.test.mjs` checks the arithmetic against
synthetic runs (a healthy run, a leak, an out-of-memory kill, a missing sampler). A run fails when:

* any cgroup records an `oom` or `oom_kill`, the host kills a process, or a container is OOM killed or restarted;
* the capped limits or the V8 heap flag differ from the shipped ones;
* process memory exceeds a ceiling (table below);
* the sampler's coverage is below 90%, it has a gap over 3 seconds, or it recorded under 60 samples,
  or the fresh-idle or warm-idle window has no samples. A run the sampler missed proves nothing.

The ceilings are the largest of two full runs on 2026-11-03 plus about 20% for CI machines:

| MiB | Measured | Capped ceiling | Uncapped measured | Uncapped ceiling |
| :--- | :--- | :--- | :--- | :--- |
| App RSS, peak | 422-444 | 520 | 629 | 760 |
| App RSS, warm idle | 287-303 | 360 | - | - |
| Postgres PSS, peak | 194-210 | 250 | 208 | 250 |
| Caddy RSS, peak | 54 | 70 | 55 | 70 |
| Stack, warm idle | 519-537 | 640 | - | - |
| Stack, peak | 662-680 | 820 | 860 | 1040 |

The app figure is RSS of everything in its cgroup, including the backup's second Node process and
`pg_dump`, and about 55 MiB of mapped program files that cgroup memory does not charge. Page cache is not counted: a
container's cgroup fills its limit with reclaimable cache by design. A ceiling catches a regression or a leak
larger than its headroom (about 80 MiB for the app); smaller drift is for the nightly records to show.
Raise a ceiling only with a new measurement, and update the Resource Budget in the deployment notes with it.

## Proving it can fail

`--inject-leak` starts a process in the app's cgroup that touches 160 MiB during the load. The
workflow's `canary` job (nightly and on demand) runs it and passes only if the run exits 2.

## Real 1 GB machine

CI runs on a larger machine, so it measures the budget, not the 1 GB behavior. The 1 GB proof runs
the installer on a real 1 GB guest with 1 GiB swap and samples the same cgroup counters
(`e2e/vm/README.md`, "Remote memory acceptance"). That run waits on real servers and is started by
the maintainer.
