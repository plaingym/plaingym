<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# CSV pipeline

Compose `createImportPipeline` and `createExportService` with the runtime's
`uploadsFor(gymId)` and `Jobs`. Mount `createPipelineRoutes` and
`createExportRoutes`; register `createPipelineJobs` and `createExportJobs` through
the server registry. The static part exports stay empty until this composition
is wired. Do not register both static and composed routes.

CSV uploads and run manifests live only under the gym's immutable `Uploads`
prefix. Uploads expire after 24 hours. The hourly `imports.retention` job marks
an upload's files deleted once it expires, and a run's state and error reports, or
an export's manifests, 30 days after their last write; the next upload sweep
removes them. No source bytes or preview values are
stored in PostgreSQL. Preview and dry runs perform read queries only; a dry run
still uses the infrastructure job queue and storage for its progress and report.

`MapperRegistry` takes one implementation per mapper ID. People, mat and
memberships ship as unavailable stubs that report every row as an error.
Implementations analyze rows using the supplied read-only query handle, apply
the column mapping and detect both existing and within-file duplicates. They
receive the complete immutable `sourceRows` in the run context, including after
a restart; build within-file duplicate indexes from it so skipped checkpoints
never lose earlier identities. `DuplicateIndex` and `duplicateKey` provide
normalized identities. Never use an unscoped duplicate cache.
`commit` receives at most 100 valid create/update rows and the write transaction.
It must use revision checks for updates and audit its domain writes in that same
transaction. It must never call storage, HTTP or a nested scope.

The pipeline also audits each committed chunk, including its safe counters and
issues. **TODO(CCR):** dedicated run/chunk tables should replace the temporary
audit checkpoints and storage manifests. Stable checkpoint IDs make concurrent
deliveries and restart after a committed chunk safe: inserting a duplicate audit
ID rolls back all domain writes in the losing transaction. This needs no update
privilege on the append-only audit table. Reports and
progress are recreated from those checkpoints if storage fails after commit.
Failures roll back the whole chunk, report a generic conflict for its rows, and
allow later chunks to proceed. Never restart a partial import as a new run
without reviewing committed rows.

Exports select explicit safe columns, page by primary key in 500-row short
transactions, and stream an uncompressed ZIP with one CSV per dataset. Empty
datasets still have headers. Rows created after the request are excluded;
individual pages are read at their query time, so the archive is not a database
snapshot. CSV string formulas are escaped for spreadsheet safety. Encrypted
fields, credential hashes, audit before/after payloads, processor error text and
email subject/body fields are excluded. Audit and email metadata remain present.
The schema coverage test fails if any non-system table lacks a dataset.

Download links expire one hour after completion; the hourly `imports.export.expire`
job then marks the archive deleted, and the next upload sweep removes it. Storage manifests contain the
signed link only within the requesting gym's prefix. Export jobs currently use
an immutable claim and one attempt: an interrupted export must be requested
again. **TODO(CCR):** add retention and recovery of unfinished export manifests
when dedicated run state is introduced. Expired uploads and exports are rejected
by the API but remain stored until retention is wired under the backup lock.
