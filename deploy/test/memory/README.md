<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Memory check

The **Memory** workflow (`.github/workflows/memory.yml`) runs a whole self-hosted deployment and
fails when it uses more memory than the budget, or when anything is killed for memory. It runs on
every integration branch and push to `main`, nightly, and on demand. It also measures
each push to a task branch whose changes against `main` touch `apps/server/src/infra/pdf/`,
`areas/waivers/`, `core/rate-limit*` (under `apps/server/src/`), `deploy/`, or the Memory
workflow, so the branch's latest head is measured even when its newest push changed other files.
Other task pushes skip the measurement job. Markdown-only pushes skip the workflow.

After setup and seeding, each run measures one `gym-app auto-update check` beside the running app.
`summary.json` records the CLI's kernel peak RSS in `facts.autoUpdateCheckPeakRssBytes` and the cgroup
sampler's baseline and peak stack process memory in `summary.autoUpdateCheck`. The kernel high-water
measurement captures short CLI peaks between the sampler's 500 ms samples; general budgets stay unchanged.

    node --test deploy/test/memory/budget.test.mjs    # budget arithmetic and failure classification, no Docker
    node --test deploy/test/memory/diagnostics.test.mjs
    node deploy/test/memory/run.mjs --mode both        # builds committed HEAD, then measures it
    node --test deploy/test/memory/waiver-budget.test.mjs
    node deploy/test/memory/waiver-budget.mjs baseline/capped branch/capped

The PDF acceptance command takes two capped output directories, baseline first, and reads their
`summary.json` files plus the branch's `state.json`. Make each pair back to back on the same machine:
build `main` with the same allocator defaults as the branch, run its existing workload, then run the
branch's 20-page, 10 MiB uploaded PDF workload with six signed copies. Both runs must succeed and
pass the general capped budgets below. The branch's whole-stack process-memory peak may increase
by at most **100 MB (100,000,000 bytes)** over the baseline. This relative check does not relax any
general ceiling, including the app's 360 MiB warm-idle limit. Repeat the pair to check reproducibility;
record requests served and p50/p95 response times alongside memory.

The runtime image sets `MALLOC_MMAP_THRESHOLD_=131072` and `MALLOC_ARENA_MAX=2` for **all app
processes**, including backup subprocesses. The fixed mmap threshold prevents glibc from raising it
after freeing a large allocation and then retaining later large freed buffers in its heap; the arena
limit bounds allocator arenas. These defaults affect ordinary traffic as well as PDF work, so both
images in a PDF comparison must use them. The image's start scripts also pass `PLAINGYM_NODE_FLAGS`
(`--max-semi-space-size=4`) to `node`, so the young generation is collected sooner. The container and V8
old-space limits stay unchanged.

`run.mjs` needs Docker with Compose v2.24 or later and cgroup v2. Options: `--mode capped|uncapped|both`, `--capped-runs N` (1–5, default 1),
`--image TAG` (skip the build; `MEMORY_IMAGE` works too), `--out DIR` (default `deploy/test/memory/out`,
ignored by Git), `--inject-leak` and `--leak-mib N` (1–4096, default 160; used with `--inject-leak`). Exit code 0 means within budget, 2 the budget was exceeded or
something was killed, 1 the harness could not run (never a pass).
If the load or backup fails, the runner still stops sampling, reads Docker's kill/restart facts,
evaluates the samples and writes `summary.json`, including the workload failures and exit code.
OOM, kill or restart evidence makes that run exit 2; without it, a failed workload exits 1.
Before teardown, every run saves `diagnostics.json`: container exit state and restart counts, app,
Postgres, Caddy and sampler logs, bounded Docker events, and the host kernel log since the run began
(requires passwordless `sudo dmesg`, available on the CI runner). Failures also print this evidence,
including diagnostic commands that failed. Container environment variables are never dumped.
Samples also retain `memory.stat` (including kernel socket buffers, anonymous memory and file cache),
with their per-service peaks in the summary. Sampled OOM counters and cgroup peaks survive a later
counter reset after a restart.
The global `/proc/vmstat` OOM-kill counter includes cgroup kills; it does not by itself prove that
the host exhausted its RAM. Kernel messages identify the OOM constraint and affected cgroup, while
Docker's `oom` and `die` events retain the kill and exit code even after a restart clears `OOMKilled`.
On demand, select five capped measurements with the workflow's `capped-runs` input, or pass
`--capped-runs 5`. These are independent measurements, with separate `capped-1` through `capped-5`
artifacts; any failure fails the workflow. They are never retried or replaced with a later pass.
Setup, seed, load and backup failures are workload failures. Phase marks, sampler shutdown,
reading the sampler's files, container inspection and job counts are bookkeeping: with a completed workload and a summary,
a budget violation still exits 2 when bookkeeping fails. Bookkeeping alone exits 1, and so does
the thin evidence it can leave behind (too few samples, a sampling gap or an empty idle window).
`summary.json` is written before cleanup and again after it. Cleanup failures are logged and
saved in its `cleanupFailures`; the workload's result and violations are kept. They raise a passing run's exit code to 1 and keep
an existing 1 or 2. Both modes still run. Failure to remove a built image warns after
the summaries have been saved and preserves the check's exit code.

## What runs

The shipped `deploy/compose.yaml` (Caddy, app, PostgreSQL with the tuned settings, hardening and memory
limits installs get), laid over by `compose.memory.yaml`: no published port, CPU caps on every service
(app 1, Postgres 1, Caddy 0.5) and an S3-compatible stand-in (versitygw) as the backup bucket. Nothing
about the stack under test changes.

The shipped Caddy service bounds TCP send and receive-buffer autotuning to 512 KiB
per connection (`net.ipv4.tcp_wmem=4096 16384 524288` and
`net.ipv4.tcp_rmem=4096 131072 524288`), including the demo overlay.
Without it, the forty paused document readers could charge about 127 MiB of
kernel socket queues to Caddy's 128 MiB cgroup and kill the proxy while its RSS
stayed near 57 MiB. Limiting only sends still failed four of five capped runs;
the proxy also receives upstream data while a downstream reader pauses. The
runner verifies both live namespaced settings. The sampler records aggregate
upstream/downstream TCP payload queue lengths, without addresses, alongside
charged socket memory to distinguish the proxy legs. The workflow
also runs `tcp-throughput.mjs` in separate disposable containers with the shipped
Caddy image, memory cap and sysctls, using 50 ms of delay in each direction. A
32 MiB single download must sustain at least 3 MB/s at 100 ms RTT. These containers
are CPU-capped, lower priority, limited to 180 seconds and removed afterwards.
The forty-reader workload, memory budgets and leak canary are unchanged.

1. **Setup** through the API: owner, gym, packs, and encrypted backups to the stand-in bucket.
2. **Seed**: 100 households with 300 members, an uploaded 20-page, 10 MiB waiver PDF and six signatures; a 115 MB
   table, read into `shared_buffers` with `pg_prewarm`, so PostgreSQL is warm and larger than its buffers.
3. **Load for 45 seconds**: 20 concurrent workers over list, health and page routes; six signed
   copies rendered and merged at once, twice, then downloaded through their signed URLs; forty slow readers (each
   stops for three seconds after its first chunk) opening the 10 MiB template document at once from one address,
   which the app streams rather than holding a copy per reader; an encrypted `maintenance.mjs snapshot` (the app's `age`
   encryption and `pg_dump`) started five seconds in; the in-process job worker runs throughout.
4. **Settle** for 12 seconds, to measure warm idle.

`waiver-pdf.mjs` creates the deterministic input with no PDF dependencies in the load container.
More than 99% of its bytes are an uncompressed image referenced by the original pages; merging
must retain that resource. The seed checks the server's page count, size and SHA-256, and load
fails if a downloaded signed copy has lost the resource. The server PDF tests independently
parse the fixture and merged copy and check their page counts and text. The fixture is synthetic;
hostile validation fixtures are never opened in a browser.

The load generator and sampler run in containers of their own (CPU-capped, `nice`, with `timeout`),
and the run is removed afterwards: containers, volumes, network and the image it built.
SIGINT (Ctrl+C) and SIGTERM stop active commands and run the same cleanup, including the named
load containers. Interrupted runs exit 130 or 143 respectively. An image supplied with `--image`
is kept; only an image built by the runner is removed.
On POSIX, cleanup commands run in a detached process group, so a second Ctrl+C cannot interrupt
their Docker clients. Cleanup commands have a 120-second timeout that kills the whole
process group; their pipe draining after client exit is bounded too. After removal, `docker ps`
checks for remaining sampler and loader containers, for up to 10 seconds while a removal already
in progress finishes. An unterminated final sample line is dropped; malformed complete lines
still fail parsing.

## What is measured

`sampler.mjs` runs in a privileged container sharing the host's process and cgroup namespaces (so it
reads the same files on a CI runner and on Docker Desktop). Every 500 ms, for each service:

* cgroup `memory.current`, `memory.peak`, `memory.max`, `memory.swap.current` and `memory.events`
  (`oom`, `oom_kill`);
* the **RSS** of the service's processes (app, Caddy; the app's includes `pg_dump` and anything else in
  its cgroup) and their **PSS** (Postgres: summing RSS would count its shared buffers once per backend).

It also records the host's OOM kill counter. After the run Docker's own `OOMKilled` and restart count
for each container are read, plus the job table's status counts.
Phase marks normally come from the sampler container, on the same clock as its samples.
If a mark or the marks file is missing, the runner uses its host-clock fallback for that mark.
`summary.json` records `clock.samples`, the clock for each entry in `clock.marks`, and a note
that host and container clocks can differ on Docker Desktop.

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

Two capped PDF runs on 2026-11-07 with the image's allocator defaults measured app RSS peaks of
395.0–405.8 MiB and warm idle of 205.9–237.6 MiB; stack peaks were 637.4–640.4 MiB and stack warm
idle 451.9–472.5 MiB. Compared pairwise with `main` using the same allocator, stack peak increased
by 91.7 MB and 36.0 MB. Both pairs passed the relative PDF check and every general capped budget.
The original calibration and ceilings above are retained. These are Docker Desktop measurements,
not a new whole-host 1 GB proof.

The app figure is RSS of everything in its cgroup, including the backup's second Node process and
`pg_dump`, and about 55 MiB of mapped program files that cgroup memory does not charge. Page cache is not counted: a
container's cgroup fills its limit with reclaimable cache by design. A ceiling catches a regression or a leak
larger than its headroom (about 80 MiB for the app); smaller drift is for the nightly records to show.
Raise a ceiling only with a new measurement, and update the Resource Budget in the deployment notes with it.

## Proving it can fail

`--inject-leak` starts a process in the app's cgroup that touches 160 MiB during the load. The
workflow's `canary` job (nightly and on demand) runs it and passes only if the run exits 2.
To exercise an actual kill under the shipped 512 MiB app limit, use
`--mode capped --inject-leak --leak-mib 768`. The summary retains the OOM or restart evidence
even when the kill breaks the traffic or backup.

## Real 1 GB machine

CI runs on a larger machine, so it measures the budget, not the 1 GB behavior. The 1 GB proof runs
the installer on a real 1 GB guest with 1 GiB swap and samples the same cgroup counters
(`e2e/vm/README.md`, "Remote memory acceptance"). That run waits on real servers and is started by
the maintainer.
