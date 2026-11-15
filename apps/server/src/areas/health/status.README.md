<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# System health

`GET /api/health` requires `settings.manage`. The page renders all contracted tiles,
including providers that are not configured. Each provider uses the frozen
`HealthTileProvider` interface; failures and malformed payloads become an unavailable
tile without exposing exception messages. Responses are not cached.

The default route uses `createStatusProviders()` with the process environment.
`configureHealthStatus({ env, providers })` lets runtime supply its explicit environment
and additional providers. `createHealthService` and `createStatusRoutes` support isolated
composition. Additional providers must have unique IDs from `healthTileIds`.

Backup checks use `backup_runs` in system context only after the backup configuration
matches the requesting gym. Multi mode exposes no install snapshot history. Successful
records must still appear in the authenticated object inventory (complete dump, manifest,
references, and upload blobs). This checks backup availability and reference authentication;
it does not decrypt backups or replace a restore drill. Age starts at the dump snapshot,
with a warning after two hours. Capacity includes current storage, one more database and
manifest, and the backup runner's 128 MiB reserve. A failed inventory stops pruning.

Restore admission uses `restore-state.json` and one durable lease per app process in
`restore-activity/`, shared by requests and job executions. Activity counts stay in memory;
ordinary requests check their lease still exists and rewrite it only if lost. The gate checks the journal before
admission and again after registering the process lease, and counts pending admissions
while closing. A local close waits on a promise resolved when its count reaches zero. A separate maintenance
CLI drains the same process leases. Every 100 ms the monitor checks for a lost lease, including while busy;
when idle it also checks the journal and removes its lease once admission is closed and its count is zero.
The monitor caches the journal by file identity, timestamps and size; request admission always reads it afresh.
Read and lease-maintenance errors are logged once per operation and error kind during a continuous failure as
`restore.activity_monitor_failed`, with the PID and a redacted cause. Failed reads or removals keep the
lease registered for retry. A drain reports each waiting PID every five seconds (`restore.drain_waiting`
in server logs, a plain progress line in the CLI) and fails after five minutes without drain progress, keeping admission closed.
Finishing a local operation or losing a waiting PID resets that timer. A successful
monitor check clears its error suppression, so a recurring failure logs again.
Linux leases include
the PID's start ticks so a crashed process or a reused PID cannot block the drain.
After restore completes, new activity registers a fresh lease. All participating processes
must share the data volume and the app container's PID namespace.

Only typed snapshot-content failures produce earlier-snapshot advice before activation.
Checksum, reference authentication, JSON and decryption failures retain their causes for
structured logging. Unexpected storage or programming failures keep their own identity;
schema compatibility and age key errors keep their existing diagnostics. The age wrapper validates
identity checksums before decrypting: an invalid key gets `InvalidAgeIdentityError` and the existing key
diagnostic. Only typed `AgeDecryptionError` header/payload failures become snapshot-content errors;
the transaction guard keeps its original error. Snapshot creation
and pruning retain the same validation rules and refusal messages.

After a restore, `gyms.settings.backupPruningHeld` holds both snapshot pruning
and explicit pruning (including its upload sweep) while new snapshots continue,
until the bucket reaches the retention budget and the snapshot's budget check fails.
The Last backup tile reports `pruningHeld` separately from an inventory failure.
Its warning names the hold and explains that new snapshots stop at the retention budget;
it replaces the healthy and capacity messages but not the missing or overdue snapshot ones.
The snapshot named by an active `SCHEMA_ROLLBACK_FLOOR` / `SCHEMA_SNAPSHOT` guard
is retained without an age limit, including its referenced blobs and uploads, until
a later guard replaces or clears it. Normal pre-upgrade retention still keeps two
snapshots for up to 30 days; the guard's extra snapshot counts toward the same budget.
Settings and Health share the backup actions: `GET /api/health/backups` reads the
state and `POST /api/health/backups/now` queues `health.backup.manual` in the batch
lane so a slow snapshot doesn't block the gym's regular jobs; both endpoints require
`settings.manage` (owners/admins). The request UUID, job and audit commit in one
short gym transaction. Pending/running requests refuse a second UUID, retries of
the current UUID return its state, and a failed job is reflected back into that state.
Stored manual state strips unknown fields and treats unknown statuses as finished;
unreadable manual state cannot block the owner's hold release. Idle polls read the
gym once and skip failed-job recovery; configuration is cached for the normal
one-minute health interval across two-second progress polls, invalidated by gym
revision changes (requests and workers validate it afresh). A success-state write
failure fails the job without the snapshot-failure write; job recovery then records the request
as interrupted (`failed`, no snapshot ID, `backup.failed` audit), though the snapshot was published.
The browser keeps a request UUID only after a network error or 5xx response and
clears it after any definite 2xx or 4xx response, including a stale-request conflict.
The existing backup advisory lock serializes snapshots. No snapshot I/O runs in
the route's transaction. The response shows completion time and snapshot ID.
`POST /api/health/backups/confirm-old-server-gone` requires `integrations.manage`
(owner), `confirmed: true`, and the current gym revision. It clears only the
requesting gym's hold and audits the confirmation. Neither action runs in multi
mode, during a restore, or without maintenance configuration; requests also need
the install's configured backup gym to match the requester.
No bucket names, filesystem paths, job errors, or SMTP credentials enter responses.

The SMTP check validates configuration rather than attempting a send. It uses
`SmtpResolver.status(gymId)`, one read and decrypt, to report gym versus install
configuration; stored gym settings that can't be read give a warning that names
them, while the message describes the install's settings or none that mail then
uses. The providers parse `APP_ENCRYPTION_KEY` once, on first use. In demo mode
(`DEMO_MODE=true`) it reports the in-app outbox as ready without consulting SMTP, since
demo gyms send no email.
`lastTestAt` is the latest submitted SMTP test, sent or failed, read from the gym's
`integrations.email_tested` and `setup.email_tested` audit rows, counted only while the
gym's own SMTP settings are in use. A failed test leaves saved settings unchanged and
gives the tile a warning that names the failed test. Legacy email saves and step 5 rows
without a test field count the same way; explicit wizard skips do not count. Removing
settings clears earlier tests. The install's own `SMTP_*` settings are never tested
here, so a gym using them shows no test, even after a failed test of settings it never
saved.

Malformed install Google variables are reported to single-gym owners only. With a
working stored client the Google tile reports that client in use and warns about
the ignored variables; without one it reports an error. Multi-gym owners see only
their effective Google configuration; the malformed variables stay in startup logs.

TODO: add an oldest failure timestamp to `JobStatsQuery`; the response uses null rather
than the pending-job timestamp. Disk details hold the volume with least free space; the
message reports both uploads and staging (the uploads volume alone when `BACKUP_STAGING_DIR` isn't set, as in multi-gym mode). TODO: allow separate volume details. Disk warning
means less than 10% or 1 GiB available; error means less than the backup reserve (128 MiB).
The available-update tile and `GET /api/health/update` (the admin banner's own route, also
`settings.manage`) come from `updates.ts`: one process-wide `ReleaseCheck` per repository reads
`api.github.com/repos/<RELEASE_REPOSITORY>/releases/latest` (default `plaingym/plaingym`, the repository the
updater follows; the release page must sit under it) without a token at most once a day. A read never waits on
the network: with nothing cached it starts the request in the background and the tile is `unavailable` with no
`checkedAt` until it arrives (the banner asks again each minute meanwhile). After a failed request with nothing cached
it is `unavailable` with `checkedAt` set to the failure and its own message (the banner then keeps its usual pace; the
check retries hourly). A failed, oversized (refused by `Content-Length`, or once the stream passes 256 KiB), draft, pre-release or
off-host answer keeps the last good one and retries after an hour. A newer minor or major is `warning` with
`available: true` (the banner). A newer patch is `healthy` with `available: false` while the nightly update is
expected to install it, and `warning` with `available: true` when it is not: the gym's automatic-updates switch is off,
no check has run for `staleAfterHours` (`auto-update.ts`), or the last attempt skipped, rolled back or failed
(`patchHoldReason`, which reads the same switch and attempt as the `automatic_updates` tile and shares its
`classifyAttempt` verdict; a read that fails keeps the quiet answer). An attempt holds back only the release it was about:
one for an older version than the newest release doesn't, since tonight's check tries the newest. The message carries the
advice: update by hand for the switch and a stopped timer; never install by hand a release the updater refused on purpose
(signature, digest, manifest, or a database change); otherwise the reason's own advice. The banner shows that message. Multi-gym mode, `UPDATE_CHECK=off`, a build whose version is not `X.Y.Z` or is `0.0.0` (a development
build), are `not_configured`. A `RELEASE_REPOSITORY` that is not `owner/name` (or has a dots-only segment) answers `warning` with the banner, saying patches can't install. An install that has never reported a check is stale 50 hours after it was first seen (stored once, on the first read). A transient skip (`release_list_unavailable`, `manifest_unavailable`, `pull_failed`, `snapshot_failed`, `check_failed`) raises the banner only after two in a row. When an attempt targets a newer release than the cached one, the message names the attempt's target. The update tile and the banner read the auto-update state once per request. `configureUpdateRoutes({ env })`
(`updates.routes.ts`) gives the route the runtime's environment, as `configureHealthStatus` does the tile.
Running version uses non-empty `APP_VERSION` and `APP_REVISION`, falling back to
the identity embedded at build time (computed from the checkout for tsx
development; source archives use `<package version>+unknown` and commit `unknown`). The image sets
`APP_VERSION` and `APP_REVISION` from its `VERSION` and `REVISION` build arguments.
The version tile includes the short commit in its message. `/healthz` exposes both
the version and full commit without caching, for the browser's navigation guard.
Build metadata (`+...`) never counts as a release for update checks.

The Google sign-in tile (`google_login`) is `healthy` when the gym has a Google client (the install's `GOOGLE_*`
variables, or in single-gym mode the gym's stored client) and `not_configured` otherwise. When the install's variables
are malformed (only one set, whitespace, over 512 characters), the app starts without them and the tile is `error`,
its message naming the variable and the reason (never the value) until `.env` is corrected and the app restarted.
