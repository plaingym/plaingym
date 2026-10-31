<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# CSV pipeline

Compose `createImportPipeline` and `createExportService` with the runtime's
`uploadsFor(gymId)` and `Jobs`. Mount `createPipelineRoutes` and
`createExportRoutes`; register `createPipelineJobs` and `createExportJobs` through
the server registry. The static part exports stay empty until this composition
is wired. Do not register both static and composed routes. Import and export
runs are batch jobs (`importBatchJobs`, `exportBatchJobs`): when the worker's
queue lists them in its batch lane (`infra/jobs/README.md`), they run without
holding up the gym's webhooks and notices.

CSV uploads live under the gym's immutable `Uploads` prefix and expire after
24 hours. Run state lives in the gym-owned `import_runs`, `import_chunks`, and
`export_runs` tables, with forced row-level security. The hourly
`imports.retention` job marks expired upload files deleted and removes runs and
their chunk reports 30 days after their last update. It also marks legacy run
files and export archives deleted; the next upload sweep removes those bytes.
No source bytes or preview values are stored in PostgreSQL. Preview only reads
domain data; dry runs write operational progress and safe issues to the run
tables, without changing domain data or writing import audits.

A preview is stored once per upload, plan (mapper, columns, duplicate policy),
timezone and import revision, under the upload's own prefix
(`<gym>/imports/uploads/<id>/preview/<key>/`, the key a hash of all four). The
first request parses the CSV once and analyzes it chunk by chunk, writing the
preview rows (issues are not stored: the response doesn't return them) to
5,000-row files under a new `pages/<generation>/`, about 20 files for 100,000
rows. It writes the summary last, at `<bucket>/summary.json`, where the bucket is
the time the computation finished divided by the five-minute `PREVIEW_LIFETIME`.
Storage is never listed. A page request reads `meta.json`, computes the summary
keys for the current and the previous bucket, and reads the one or two row files
its page spans, so it never reads the CSV and costs the same however much the gym
has stored. The process remembers the newest summary it stored or read for each
plan, so a warm page in that process reads only `meta.json` and the row files.
A preview is served for `PREVIEW_LIFETIME` from when its computation finished, so
one slower than that is still served for the full lifetime. Two requests for one
preview in a process share one pass; each plan keeps its own preview while it is
fresh.

The import revision changes whenever a real (not dry-run) import run of the gym
is created or completes, or retention removes runs: one aggregate over the gym's
`import_runs`, bounded by `import_runs_retention_idx`. A preview computed before
any of those is never found again. That covers previews of every upload (people
before memberships) and runs that start or finish while a preview is computing;
`start` itself does no storage work after the run is committed and queued. Edits
made by hand are not tracked, so a preview can be up to five minutes behind them.

Upload keys are immutable, so every computation writes new keys. A computation
that fails marks its own row files deleted; one that crashes leaves row files
under its own generation, which block nothing. When another process stored the
same bucket's summary first, that preview is served and this computation's rows
are marked deleted. A summary key that a crashed writer reserved and never wrote
can't be read or written: until the next bucket, each request is served
from its own computation's rows, which are marked deleted once its page is read. After storing a summary, a computation marks deleted the previous
bucket's preview of the same plan (its summary names its row files); every other
preview file goes with its upload. Stored previews hold row values, so
`imports.retention` marks them deleted with the whole upload prefix (a preview
written late never extends the upload's deadline), and they are never read for
another gym: every key starts with the gym ID. A full 100,000-row preview takes
about 32 MB (21 files).

`start` takes the row count from the upload's `meta.json` and never reads the CSV;
the job parses it when it runs, and fails the run if the file's row count differs from
the run's. Parsing slices each cell out of the text rather than
appending character by character, and a preview or run holds the parsed document and
the mapper's whole-file index, never every planned row.

`MapperRegistry` takes one implementation per mapper ID: people, mat and
memberships.
Implementations analyze rows using the supplied read-only query handle, apply
the column mapping and detect both existing and within-file duplicates. They
receive the complete immutable `sourceRows` in the run context, including after
a restart; build within-file duplicate indexes from it so skipped checkpoints
never lose earlier identities. `DuplicateIndex` and `duplicateKey` provide
normalized identities. Never use an unscoped duplicate cache.
`commit` receives at most 100 valid create/update rows and the write transaction.
It must use revision checks for updates and audit its domain writes in that same
transaction. It must never call storage, HTTP or a nested scope.

The pipeline audits each committed chunk with safe counters. Each short chunk
transaction locks the run row, skips any already completed chunk, and commits
domain writes, the chunk result, and aggregate progress together. Concurrent
deliveries and a restart after losing the commit acknowledgement cannot duplicate
domain writes. Status and error reports remain readable from PostgreSQL alone,
even if storage is unavailable; executing unfinished chunks still needs the CSV.
Failures roll back the whole chunk, report a generic conflict for its rows, and
allow later chunks to proceed. Never restart a partial import as a new run
without reviewing committed rows.

Runs created by older releases continue using their immutable manifests, issue
files, and atomic audit checkpoints. Reads check the tables first, then use the
legacy protocol only when there is no table row. Legacy runs are not copied into
tables: this keeps them compatible with an older worker still writing the same
run during an upgrade. A legacy run without a recorded timezone keeps using UTC.
During an upgrade, an old-release worker cannot execute a run created in the
tables: it finds no `run.json`, fails, and consumes an attempt. Drain or stop
old workers before creating new runs to avoid burning attempts while releases overlap.

Exports select explicit safe columns, page by primary key in 500-row short
transactions, and stream an uncompressed ZIP with one CSV per dataset. Empty
datasets still have headers. Rows created after the request are excluded;
individual pages are read at their query time, so the archive is not a database
snapshot. CSV string formulas are escaped for spreadsheet safety. Encrypted
fields, credential hashes, audit before/after payloads, processor error text and
email subject/body fields are excluded. Audit and email metadata remain present.
The schema coverage test requires every domain table to have a dataset.
Operational import/export run state is excluded so dataset contracts remain
stable and retained issues and signed download links stay out of the archive.

Download links expire one hour after completion; the hourly `imports.export.expire`
job then marks the archive deleted, and the next upload sweep removes it. New
exports store their signed link in the gym-scoped run row. Exports use a database
compare-and-set claim (an immutable storage claim for legacy runs) and one
attempt. If a worker crashes on its last attempt, the job queue fails the expired
lease without calling the handler. The hourly `imports.retention` sweep recovers
these abandoned table runs by marking them `failed` with a completion time:
imports at 24 hours after run creation, and exports after 48 hours without a run
state update. An import's CSV was uploaded before its run was created, so it is
guaranteed expired by that 24-hour bound. Exports do not update their run row
while streaming; the conservative 48-hour bound allows two full days for a large
gym's archive, far beyond the queue's 30-second lease and 10-second heartbeat.
It is an abandonment deadline, not a check that the worker's lease expired.
Status compare-and-set prevents recovery from overwriting a concurrent successful
finish. Recovery preserves committed import rows, counters, and issues; it does
not retry either run or change legacy manifests. Failed run state remains
available for 30 days after recovery before normal retention removes it and
any remaining files. Request another export after inspecting the failed status.
