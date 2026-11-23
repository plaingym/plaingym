<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# CSV pipeline

Compose `createImportPipeline` and `createExportService` with the runtime's
`uploadsFor(gymId)` and `Jobs`. Pass the gym's `paymentsFor(gymId)` resolver to
`createImportPipeline` so the people mapper can resolve bank accounts. Mount `createPipelineRoutes` and
`createExportRoutes`; register `createPipelineJobs` and `createExportJobs` through
the server registry. The static part exports stay empty until this composition
is wired. Do not register both static and composed routes. Import and export
runs are batch jobs: their registrations name the batch lane
(`infra/jobs/README.md`), so they run without holding up the gym's webhooks and
notices.

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
timezone, import revision and the gym's settings revision, under the upload's
own prefix (`<gym>/imports/uploads/<id>/preview/<key>/`, the key a hash of all
five). The gym's settings revision changes when Stripe is connected or removed,
the currency changes or any other gym setting is saved, so a preview computed
before such a save is never served after it. The
first computation parses the CSV once and analyzes it chunk by chunk, writing the
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
fresh. A process shares one memory budget across all pipeline instances:
one third of V8's heap limit, capped at 128 MiB. A computation reserves 4 MiB plus
eight times its upload size and 256 bytes per row, up to the whole budget. Small
previews can run together; a large preview waits for the allowance to be free.
Each gym has a FIFO queue. Waiting gyms take turns in order of their last
admission. A gym joining the queue with no running or waiting previews takes a
turn just ahead of the most recent admission, after any older turns. The first
preview in the selected gym's queue must fit before the next turn can start.
At most 16 previews may wait in each process, with at most three waiting per
gym. Running previews do not count against either limit.
Admission beyond either bound answers `503 unavailable` with a safe
queue-busy explanation, leaving room for other gyms. A retry for
the same active plan shares its ticket across pipeline instances and does not
consume another queue position. This coalescing, like the memory allowance, is
process-local; separate processes may compute the same plan, with the existing
immutable-summary winner behavior described below.
Upload metadata records the byte size internally; older uploads without it reserve
for the maximum upload size. This does not change the upload response.

Each admitted computation has a two-minute deadline. It passes an abort signal
through storage metadata and object reads, including body consumption, and checks
the deadline between mapper chunks and writes. The budget is released only when
the computation settles, including work already in a write or mapper chunk.
Queue waiting and the ticket's computing-marker write do not consume the
computation's deadline. Cancellation at a deadline check answers
`unavailable` with the preview timeout message. Unrelated storage or mapper
failures retain their cause. A computation whose summary is already stored
keeps its result, even if removing the previous preview's files runs past the
deadline. If its summary write finishes after the ticket stops, the stopped
ticket answers the timeout message and the published summary stays available
for a new Preview.

`POST /api/imports/preview` validates the upload and plan, then answers a ready
preview page or a `queued`/`computing` ticket without awaiting computation or
admission to the memory allowance. `GET
/api/imports/uploads/{uploadId}/previews/{id}` reads that ticket's state and, when
ready, its requested page. Both routes require `settings.manage` and send
`Cache-Control: no-store`. A ticket's metadata, computing marker and terminal
result live under the upload's `preview/requests/<id>/` prefix, so ticket writes
and renewals do not extend upload retention. A poll can reach
another app process; it reads the same stored progress and result without
starting work. The coordinator answers its own pending tickets with live leases from memory,
checking the cached gym, upload and expiry without storage or revision reads.
Other processes check upload ownership and expiry in storage. The gym's current
import revision is read only when a ready result exists, before returning rows.
Failed computations store only a safe
application explanation; other failures use a generic retry message. A retry of
a failed start gets a new ticket. All ticket files expire with the upload.
Pending work renews a 60-second lease every ten seconds while queued,
computing, cleaning up, or saving its terminal result. Each renewal writes an
immutable `lease/<ten-second-bucket>.json` key valid from the bucket's start.
Readers check their current and five preceding buckets newest first and stop
at the first hit. After a miss they check the two buckets ahead in parallel to
allow for a reader clock that is behind the writer's.
The ticket stops when the time since it started reaches
`(queueLimit + 1) × (previewTimeoutMs + PREVIEW_CLEANUP_MS)` (about 37 minutes
by default). A new Preview also stops and replaces a lapsed ticket, including
one whose first lease or ticket metadata write is still pending after ten
seconds. Stopping a ticket removes queued work from the memory queue and
cancels running work at its next deadline check.
When a result is saved, the process stops renewing and marks only the newest
eight lease keys deleted in parallel with a shared ten-second timeout. Older
keys expire with the upload. A process that exits or fails to save its result
leaves the last lease to lapse. A lapsed ticket still returns its stored
result if available.
Tickets written by earlier releases at `preview-requests/<id>/` remain readable
and retain their original expiry behavior.
The internal `preview` helper joins the same ticket and awaits its computation;
HTTP routes use `requestPreview` and `getPreview`. The shared budget owns ticket
coalescing as well as admission.

The import page keeps polling its previous ticket when columns or duplicate
policy change, and disables Preview until it finishes. An obsolete result is
discarded. Network and server errors during polling are retried up to three
times; an explicit failed ticket is terminal and is never retried automatically.

All three mappers use gym-scoped indexes on generated, PostgreSQL-folded member
last names; mat and memberships also use the folded email index. First names
remain a filter on the indexed candidates. The complete supplied identity still
decides matches and ambiguity, and anonymized members are excluded. These lookup
columns update automatically with the source fields and are omitted from exports.

The import revision changes whenever a real (not dry-run) import run of the gym
is created or completes, or retention removes runs: one aggregate over the gym's
`import_runs`, bounded by `import_runs_retention_idx`. It also changes whenever
the gym's settings are saved (`gyms.revision`, read in the same transaction).
A preview computed before any of those is never found again, and a ready ticket
computed before one answers that the preview changed. That covers previews of every upload (people
before memberships) and runs that start or finish while a preview is computing;
`start` itself does no storage work after the run is committed and queued. Edits
made by hand are not tracked, so a preview can be up to five minutes behind them.

Upload keys are immutable, so every computation writes new keys. A computation
that fails, or passes its deadline, marks its own row files deleted, within a
ten-second limit of its own; upload retention removes any that limit leaves. One
that crashes leaves row files
under its own generation, which block nothing. When another process stored the
same bucket's summary first, that preview is served and this computation's rows
are marked deleted. A summary key that a crashed writer reserved and never wrote
can't be read or written: the computing process remembers its own summary and
keeps its row files, and the asynchronous ticket also stores that summary so
polls in other processes can read those rows. Those files go with the upload.
After storing a summary, a computation marks deleted the previous
bucket's preview of the same plan (its summary names its row files); every other
preview file goes with its upload. Stored previews hold row values, so
`imports.retention` marks them deleted with the whole upload prefix (a preview
written late never extends the upload's deadline), and they are never read for
another gym: every key starts with the gym ID. A full 100,000-row preview takes
about 32 MB (21 files).

`start` takes the row count from the upload's `meta.json` and never reads the CSV;
the job parses it when it runs, and fails the run if the file's row count differs from
the run's. Parsed rows share the source text, a header index, and packed cell
offsets, allocated once after counting separators outside quoted cells; that count
refuses a file past the row or column limit before anything is allocated. Blank
lines need no offsets, and the final document uses a view without copying the buffer.
Mappers use `csvValue` to slice only the cells they need; quoted escapes
are decoded on access. The compatibility `row.values` getter materializes one row
for inspection. A preview or run holds the parsed document and
the mapper's whole-file index, never every planned row.

The admin preview displays bounded explanations only for the API's own
`invalid_request` 400, `not_found` 404 and `unavailable` 503 responses, using
the shared web error reader. Other failures show the generic request error. Changing the mapper, duplicate policy or column mapping clears
the previous preview and its error. The page polls pending tickets every second,
shows queued/computing progress and stops polling on ready or failed state.
Changing the plan or leaving the page detaches its old poll; a late answer cannot
replace the current plan's preview.

An upload reads the file's bytes into a buffer only to decode them, so they are
released before the text is parsed; it keeps only the header and row count, and
streams the stored `source.csv` from the uploaded file itself.

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
datasets still have headers. Saved manifests retain their dataset order. Dataset
names unknown to the running release are omitted from the archive and returned
manifest, so queued exports can finish after a rollback to a release with a
smaller catalog. Completion stores that filtered list with the run, in the
database row and in a legacy finished manifest, so a later roll-forward still
reports only the datasets its archive holds. When no saved dataset is known, the
run fails before an archive is written with "This export lists no data this
version can export."; reading it reports that failure instead of returning a
manifest without datasets. Rows created after the request are excluded;
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
finish and prevents a late export finisher from overwriting a recovery failure.
A late export finisher marks its archive deleted instead of publishing its link.
Recovery preserves committed import rows, counters, and issues; it does
not retry either run or change legacy manifests. Failed run state remains
available for 30 days after recovery before normal retention removes it and
any remaining files. Request another export after inspecting the failed status.

Import runs retain the stored `failed` status when any row has an issue. The admin
page distinguishes a finished run with row errors (`processedRows === totalRows`
and `errorCount > 0`) from one that stopped short, and shows the committed count
for both. A clean run reads Complete.
