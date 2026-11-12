<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Automatic updates

The host's `update.sh --patch` installs patch releases each night (`deploy/README.md`, "Automatic patch updates").
The app never holds the Docker socket. This area reports update status and sends owners notices; installation stays on the host.

* **The switch.** `areas/settings/auto-update.ts` keeps it in the gym's opaque `settings` as
  `automaticUpdates: { enabled, revision }`; a gym without the key has updates on. The switch has its own revision,
  so saving it neither moves nor checks the gym revision the other settings sections share; a stale revision is a
  `RevisionConflictError` (409). Each change writes `settings.automatic_updates.updated`. It lives with the settings
  because only `areas/settings` may touch the `gyms` table.
* **First observation.** The state reader persists `automaticUpdatesFirstSeen` through the settings service on its
  first read, under a gym-row lock with a system audit event; later reads take no lock. It preserves other settings and both revisions.
  The health tiles share one state read per request; the next request reads again.
* **Routes.** `GET` and `PUT /api/health/auto-update` (`autoUpdateContracts`, owners only through
  `integrations.manage`) read and change the switch. `available` is false on an install that serves several gyms,
  where no updater runs, and `PUT` answers 409 there.
* **The host's command.** `gym-app auto-update check` prints `restore=…` and, unless a restore holds the install,
  `setup=false` before the setup wizard has created the gym, or `setup=true`, `enabled=…`, `backups=…` and
  `timezone=…`; the host asks every hour. `gym-app auto-update record --at --result [--reason] [--from] [--to]
  [--failures] [--down-at]` stores one attempt as an audit row (`health.auto_update.attempted`, target type
  `auto_update`), refused during a restore; an attempt that updated, rolled back or failed gets a second row
  under `health.auto_update.changed`, so the last change is found however many checks follow it. A replayed
  report (an instant already among the latest attempts) stores nothing new. Exit 2 means the input is invalid,
  which the host drops rather than retries.
  `autoUpdateAttemptSchema` accepts each result only with the facts it can know: `up_to_date` the running
  version, `updated`, `rolled_back` and `failed` both versions and (for the last two) a reason, `skipped` a reason.
  `failures` (rolled back, failed, or a `repeated_failure` skip, which needs at least 2) is how many automatic
  attempts at the target release have failed; `downAt` belongs only to `rolled_back` with `rollback_failed`, the
  recovery from a failed rollback, and is when the update stopped the app.
  Single-gym installs only. It is registered in `cli/index.ts`.
* **Owner notices.** After recording a rolled-back or failed attempt, the command resolves the gym's SMTP
  configuration through `createSmtpResolver` and sends each owner a separate notice outside transactions.
  Durable per-attempt, per-recipient delivery keys prevent accepted or uncertain sends from repeating, and one
  owner's failed send doesn't stop the others; definite non-sends exit 3 and leave a separate host notice pending for retry. The host records with
  `--notice deferred`, drains results, then runs `gym-app auto-update notice` with the same attempt flags.
  Retrying a notice never writes an attempt or changes the tile. An unsent failed-rollback notice is
  superseded by the recovery notice for the same outage before any notice is sent. Other notice errors
  are logged and exit 0, without delaying results. These staff notices are exempt from
  `memberEmailsEnabled`, as classified in the go-live inventory. No SMTP means no email. Times in a notice,
  including a recovery's outage, use the gym's timezone.
* **The tile.** `createAutoUpdateHealthProvider` reads the switch, the latest attempt and the last change. Off, or no attempt yet:
  not set up. Up to date or updated: healthy. Rolled back: warning. Failed (the rollback failed too): error.
  A recovery from a failed rollback (warning) says the site was down from `downAt` until the attempt's time. A
  rolled-back or failed attempt with `failures` 1 says the next night tries the release again; from 2, that
  automatic updates wait for a newer patch (`--patch --now` retries it), and the later `repeated_failure` skips
  say the same. When the last change isn't the latest attempt, the message adds it: "Last update: v1.2.3 → v1.2.4
  on …", or the last attempt that was rolled back or failed. Attempts recorded before the latest `restore.completed`
  are ignored (they came from the server the backup was taken on), and the grace for a first check starts at the
  restore. The web tile labels the versions for the result (running, previous and updated, or tried version) and
  hides a version the attempt has none of.
  Skipped: a warning, or an error when the release itself was refused (bad signature, digest or manifest, or a
  patch that changes migrations); a night skipped while the switch was off reads as not set up once it is back on.
  After 50 hours without a check, a warning names the timer; an existing error retains its status and cause
  with that stale note appended. The time uses the gym's timezone. An install with no attempts gets the
  same warning 50 hours after its first observation. The message carries the reason
  (`locales/en/health/auto-update.json`).
* **Update banner.** A transient skipped attempt holds the patch banner only after two consecutive distinct
  transient skips. A good check resets that sequence. The banner uses an attempt's target when it is newer
  than the cached release, and warns when `RELEASE_REPOSITORY` is invalid, including dot-only path segments.
