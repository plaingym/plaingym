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
  `timezone=…`. `gym-app auto-update record --at --result [--reason] [--from] [--to]`
  stores one attempt as an audit row (`health.auto_update.attempted`, target type `auto_update`), refused during a
  restore. A replayed report (an instant already among the latest attempts) stores nothing new.
  `autoUpdateAttemptSchema` accepts each result only with the facts it can know: `up_to_date` the running
  version, `updated`, `rolled_back` and `failed` both versions and (for the last two) a reason, `skipped` a reason.
  Single-gym installs only. It is registered in `cli/index.ts`.
* **Owner notices.** After recording a rolled-back or failed attempt, the command resolves the gym's SMTP
  configuration through `createSmtpResolver` and sends each owner a separate notice outside transactions.
  Durable per-attempt, per-recipient delivery keys prevent accepted or uncertain sends from repeating;
  definite non-sends leave the host report pending for retry. These staff notices are exempt from
  `memberEmailsEnabled`, as classified in the go-live inventory. No SMTP means no email.
* **The tile.** `createAutoUpdateHealthProvider` reads the switch and the latest attempt. Off, or no attempt yet:
  not set up. Up to date or updated: healthy. Rolled back: warning. Failed (the rollback failed too): error.
  Skipped: a warning, or an error when the release itself was refused (bad signature, digest or manifest, or a
  patch that changes migrations); a night skipped while the switch was off reads as not set up once it is back on.
  After 50 hours without a check, a warning names the timer; an existing error retains its status and cause
  with that stale note appended. The time uses the gym's timezone. An install with no attempts gets the
  same warning 50 hours after its first observation. The message carries the reason
  (`locales/en/health/auto-update.json`).
* **Update banner.** A transient skipped attempt holds the patch banner only after two consecutive distinct
  transient skips. A good check resets that sequence. The banner uses an attempt's target when it is newer
  than the cached release, and warns when `RELEASE_REPOSITORY` is invalid, including dot-only path segments.
