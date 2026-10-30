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

`MapperRegistry` takes one implementation per mapper ID. People and mat have
implementations; memberships has an unavailable stub that reports each row as an error.
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
