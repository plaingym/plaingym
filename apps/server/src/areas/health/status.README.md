<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# System health

`GET /api/health` requires `settings.manage`. The page renders all contracted tiles,
including providers that are not configured. Each provider uses the frozen
`HealthTileProvider` interface; failures and malformed payloads become an unavailable
tile without exposing exception messages. Each tile has 5 seconds to answer; after that
it reads "Still checking" and the other tiles render (the slow check keeps running and
its late result is discarded; a refresh while it runs waits on that same check, one per
gym and tile, instead of starting another until the running read is 30 seconds old, when
a new one replaces it, keeping at most one replaced read tracked per gym and tile and
waiting for the newest read while it does; once the newest read is two minutes old, a
refresh starts another even while the replaced one is pending (the older read keeps
running, no longer tracked), up to at most three unsettled reads per gym and tile at once:
while three are unsettled a refresh waits on the newest, and one settling lets the next
refresh start another; a read still unsettled 30 minutes after it started no longer counts
toward the three, so a tile whose reads hang for good is checked again, but never beyond 12
unsettled reads of any age per gym and tile: at that cap a refresh waits on the newest, and
the first refresh held back by it logs `health.tile_hung` once, with the gym ID, the tile ID
and the count, until the count falls below the cap; if none of those reads ever settles, the tile reads
"Still checking" until the app restarts, even after its dependency answers again). Each read's
database statements run under a 10-second `statement_timeout` (`withStatementTimeout` from
`@plaingym/db`; the `statementTimeoutMs` option, at least the tile limit), so a read stuck in
the database is cancelled and gives its pool connection back; the cancelled read becomes the
unavailable tile. Reads stuck outside the database still count toward the caps above. A read slower
than 2 seconds logs `health.tile_slow` once, with its tile ID and duration from the read's
start; each request that reaches the 5-second limit logs
its own line with `timedOut: true`. The Last backup tile reuses its bucket inventory
for up to one minute from the start of the read that listed it (it is released from memory
after that; a running listing whose read started over 30 seconds ago is replaced by a new
one, so the service's replacement read lists again; a third listing, which a hung check
reaches only through the two-minute retry, closes the oldest one's storage connection; a
listing under an old cache key is closed by a later read once its own read started over
30 seconds ago; a clock stepped back counts a cached inventory or a running listing as
stale; and a replaced listing that finishes still fills the cache unless a later one
already has), dropped sooner when a backup or prune finishes or the destination or
the backup runs change; pruning always reads the bucket itself.

The Invoice effects tile (`invoice_effects`) stays in error while any invoice
effect has exhausted automatic recovery. It reads durable audits rather than
failed jobs, so queue retention cannot clear this warning. The list is oldest
exhaustion first and links each invoice, naming its effect kind, exhaustion time
and duplicate-refund amount. `GET /api/health/effect-failures` reads the list;
`POST /api/health/effect-failures/retry` and `.../dismiss` take `{ effectId }`.
All three require `settings.manage` (owner/admin), use only the resolved gym and
return uncached responses. The runtime supplies the billing effects service with
`configureEffectFailures(billing.effects)`.

Both actions ask for confirmation. Retry names the effect's consequence and how
long ago recovery was exhausted, including the amount for a duplicate card
refund. It resets a retained failed job or queues a missing one under its original
key, atomically with its staff audit under the invoice lock. An already queued
retry does nothing; completed or dismissed effects return conflict. Retry starts
a fresh five-reset automatic recovery budget, and a new exhaustion lists again.
Dismiss records handled by hand, removes the effect from the list and stops its
recovery. It acknowledges the effect's retained failed job in the same
transaction, so the failed-jobs tile stops counting it. Retention still deletes
the job on its usual schedule. Both actions retain the staff actor in the audit.
See [invoice effects](../billing/transitions/README.md).

The SMS tile reads `SmsResolver.status`, the gym's switch and cap, and its
`sms_daily_usage` for today in the gym timezone. `sentToday` counts reserved send
attempts, including failures or uncertain outcomes; `refusedToday` counts cap
refusals. It is healthy with a readable provider and the switch on. It warns when
texts are on without a provider, a configured provider has texts off, settings
are unreadable, the last owner test failed, or attempts were refused today. The
missing-provider message applies when there is no provider and storage is
readable. The invitation to turn on texts appears only when the provider is
readable and texts are off. Counts and the last test time/result are returned,
never numbers, bodies or credentials. Removing the provider clears older test
history.
Demo mode reports the outbox as its provider and skips stored SMS credentials.

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
An inventory failure the destination caused names its class in `destinationFailure`
(`credentials_rejected` for a key the service rejects, such as `InvalidAccessKeyId`,
`SignatureDoesNotMatch`, `InvalidToken`, `ExpiredToken`, `Unauthorized` or a bare 401;
`access_denied` for a refused access, `AccessDenied` or a bare 403, worded as a permissions
problem; `bucket_missing` or `endpoint_unreachable`; from the error's
status and code only; a bare network code counts only when a destination call raised
it, so other connection failures such as the database stay `other`) with its own message;
any other failure keeps the pruning-stopped one, and logs
`health.backup_inventory_unverified` with the reasons that stopped pruning (`suspect`, the
fixed reason texts joined by `; `, and `damagedRetained`), never an object key or snapshot ID.
The line is written once per loaded inventory: reads served from the cached inventory
within the minute don't repeat it, and the next load that still fails writes it again.
The tile reads the bucket outside the backup lock, so a run can publish while it lists: a
prefix without a reference list whose run reads `succeeded` is listed again, and left out
of that read when its reference list is there now (the next read counts it). Pruning, which
holds the lock, keeps stopping for such a prefix.
Its warning names the hold and explains that new snapshots stop at the retention budget;
it replaces the healthy and capacity messages but not the missing or overdue snapshot ones.
The snapshot named by an active `SCHEMA_ROLLBACK_FLOOR` / `SCHEMA_SNAPSHOT` guard
is retained, while complete, without an age limit, including its referenced blobs and uploads, until
a later guard replaces or clears it. Normal pre-upgrade retention still keeps two
snapshots for up to 30 days; the guard's extra snapshot counts toward the same budget.
If inventory finds the guard damaged, the tile names it in `damagedGuardSnapshot`
and uses a damaged-rollback headline unless a more serious warning applies. A damaged
guard follows normal pre-upgrade retention, so it stops blocking pruning once that
policy expires. When the guard's snapshot is in neither complete nor damaged inventory
(a damaged one pruned, or any one removed outside the app), the tile reports
`missingGuardSnapshot` and warns while the active guard still names it. A guard
whose `SCHEMA_SNAPSHOT` is the updater's `-` placeholder names no restore point. Retention receives the guard explicitly from the backup service and
the health provider's injected `env`.
The inventory reads at most four reference lists at a time and lists `blobs/` once; the
page shows `ageSeconds` as a duration ("48 minutes"), while the API keeps the number.
Settings and Health share the backup actions: `GET /api/health/backups` reads the
state and `POST /api/health/backups/now` queues `health.backup.manual` in the batch
lane so a slow snapshot doesn't block the gym's regular jobs; both endpoints require
`settings.manage` (owners/admins). The request UUID, job and audit commit in one
short gym transaction. Pending/running requests refuse a second UUID, retries of
the current UUID return its state, and a failed job is reflected back into that state.
A failed request stores its cause class in `failure` (`credentials_rejected`, `access_denied`,
`bucket_missing`, `endpoint_unreachable` or `other`, never the error's text), which the
`backup.failed` audit also records; a stored class this release doesn't know reads as
`other`, and a missing one as null.
Stored manual state strips unknown fields and treats unknown statuses as finished;
unreadable manual state cannot block the owner's hold release. Idle polls read the
gym once and skip failed-job recovery; queued/running polls re-read only if recovery
writes a terminal state. Configuration is cached for the normal
one-minute health interval across two-second progress polls, invalidated by gym
revision changes (requests and workers validate it afresh). After publication, the success-state
write gets three attempts, with 250 ms and 500 ms waits between them. A transient write failure
therefore records `succeeded` with the snapshot ID, without publishing again or recording a failed
backup. Exhausting these attempts still fails the job; recovery records that request as interrupted
(`failed`, no snapshot ID, `backup.failed` audit), although its snapshot was published.
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

The SMTP check attempts no send of its own. It uses
`SmtpResolver.status(gymId)`, one read and decrypt, to report gym versus install
configuration. Unreadable gym settings produce a warning about the saved settings.
When mail can fall back to the install's SMTP settings, the same tile names that
source. The providers parse `APP_ENCRYPTION_KEY` once, on first use. In demo mode
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
Real sends report too: while the gym's last email failed through its sending service
(`readEmailSendFailure`, `areas/settings/email-status.ts`), the tile is a warning and its
message adds the failure's class (`smtpLastFailed.<class>`: connection, secure connection,
refused login, or refused sender). The wording follows the settings the failure went
through (the row's `source`), not the ones in use now: a refused login through the
install's `SMTP_*` settings names the server's `SMTP_USER` and `SMTP_PASS` and a restart
on a single-gym install (`smtpLastFailed.authentication_install`), and whoever runs the
install on a multi-gym one (`smtpLastFailed.authentication_operator`); one through the
gym's own settings points to Settings → Integrations → Email, even when the stored value
can no longer be read. A send that works, or a change to the email settings, clears it;
a failure through the install's settings stands across restarts while those settings stay
the same (their fingerprint, `installSmtpFingerprint`), and stops counting once they
change. One recorded without a fingerprint stops counting once the app restarts. With no settings in use (and
none unreadable) the tile is `not_configured` and says only that email is not
configured, whatever failure or test came before; `details` don't change.

Malformed install Google variables are reported to single-gym owners only. With a
working stored client the Google tile reports that client in use and warns about
the ignored variables; without one it reports an error. Multi-gym owners see only
their effective Google configuration; the malformed variables stay in startup logs.

`JobStatsQuery.oldestFailureAt` is the oldest final failure time among this gym's
retained failed jobs that are not acknowledged, or null when none remain. The
worker records final completion in `finishedAt` and keeps `runAt` as the due time;
a row finished before that column existed has only `runAt`, so a failure's time is
the later of the two. Pending jobs, install jobs and other
gyms never affect this time.
The tile stays in error while any unacknowledged failed jobs remain, however old
the failure is. With none, the page leaves out the oldest failure row. A failed
job whose effect was dismissed by a release that did not yet acknowledge jobs on
Dismiss stays counted until someone acknowledges the job or retention deletes it.
The tile gets `failedVersion` from `JobStats.failedVersion`. It contains an opaque digest
of the unacknowledged jobs' IDs, failure times and failure counts (`jobs.failure_count`,
which every failure raises and a retry never resets), or `none` when the set is empty.
The page keeps this value hidden. While the tile counts failed jobs, owners and admins
(`settings.manage`) see **Acknowledge failed jobs**. A tile from a server that predates
the version (an older release, for example after a rollback) shows normally, with no
Acknowledge action until the tiles come from a server that sends one. Confirming posts the tile's
`checkedAt` as `through` and its `failedVersion`, both from when the dialog opened,
to `POST /api/health/failed-jobs/acknowledge`. In one gym transaction the server
locks the gym's unacknowledged failed jobs, computes the digest over the locked
rows, and acknowledges exactly those jobs only when it matches. When the set
changed (a job failed after the page was read, even one whose expired lease is
recorded with an earlier failure time; a counted job was retried; or a counted job
was retried in place and failed again under the same ID, even at the same recorded
time), it answers 409
`Failed jobs changed` and acknowledges nothing, so a failure after the page was read
is never acknowledged by that read. The page refreshes the tiles.
**Review Background jobs** closes the stale dialog so the owner can check the new
count and open a fresh confirmation if failures remain. It doesn't run the jobs
again; the answer is the number acknowledged, and a non-zero count writes one
`health.failed_jobs.acknowledged` audit event (`acknowledged` and `through`) in the
same transaction.
Disk details report `uploads` and `backupStaging` separately, each with filesystem
`totalBytes` and `availableBytes`, plus `sameFilesystem`: true only when a backup
staging directory is configured on the same device as the uploads directory and the
capacity difference is at most 64 MiB and at most 0.1% relative to the larger total.
Totals on ZFS or btrfs can drift between reads. If totals on the same device differ
by more than either bound, the provider reads both paths again once and uses the
second readings for the comparison, details, status, and message. A staging quota
that remains outside either bound keeps its own rows. Free space is excluded from
the comparison because two `statfs` calls on a busy disk can differ slightly. Each
figure describes the volume seen at that path. When `sameFilesystem` is true,
the message reports the lower free figure and the page shows it alongside that
path's total, using uploads when the free figures tie. Both pick that volume with
`sharedDiskVolume` (`packages/shared/src/contracts/health.ts`). The status still checks
each path's own free bytes and free-space percentage.
`backupStaging` is null when no staging directory is configured, including multi-gym
mode, which ignores `BACKUP_STAGING_DIR`; `sameFilesystem` is then false and the page
omits staging rows.
A configured directory that is missing or unreadable makes the check unavailable;
it never substitutes zero or reports a healthy upload volume as the whole check.
Neither filesystem paths nor job payloads or errors are returned. Disk warning
means less than 10% or 1 GiB available; error means less than the backup reserve (128 MiB).
The available-update tile and `GET /api/health/update` (the admin banner's own route, also
`settings.manage`) come from `updates.ts`: one process-wide `ReleaseCheck` per repository reads
`api.github.com/repos/<RELEASE_REPOSITORY>/releases/latest` (default `plaingym/plaingym`, the repository the
updater follows; the release page must sit under it) without a token at most once a day. A read never waits on
the network: with nothing cached it starts the request in the background and the tile is `unavailable` with no
`checkedAt` until it arrives (the banner asks again each minute meanwhile). After a failed request with nothing cached
it is `unavailable` with `checkedAt` set to the failure and its own message (the banner then keeps its usual pace; the
check retries hourly). GitHub answers 404 for a repository with no stable release: the tile then says no stable release
has been published yet (or asks to check `RELEASE_REPOSITORY` when following another repository; `ReleaseCheck.failure()`
is `not_found`) instead of "could not be read". A 404 writes `health.release_check_failed` at info level once per run of
404s; every other failed request writes one at warn level on each failure, with only `status` (the HTTP status, null when
there was none) and `reason` (`http`, `unusable` for a body that fails parsing or the release checks, or `network` for a
failed or timed-out fetch); it never logs the URL, body or error message. A failed, oversized (refused by
`Content-Length`, or once the stream passes 256 KiB), draft, pre-release or off-host answer keeps the last good one and retries after an hour. A newer minor or major is `warning` with
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
