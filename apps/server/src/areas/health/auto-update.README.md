<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Automatic updates

The host's `update.sh --patch` installs patch releases each night (`deploy/README.md`, "Automatic patch updates").
The app never holds the Docker socket, so this area holds only the owner's switch and the results the updater reports.

* **The switch.** `areas/settings/auto-update.ts` keeps it in the gym's opaque `settings` as
  `automaticUpdates: { enabled, revision }`; a gym without the key has updates on. The switch has its own revision,
  so saving it neither moves nor checks the gym revision the other settings sections share; a stale revision is a
  `RevisionConflictError` (409). Each change writes `settings.automatic_updates.updated`. It lives with the settings
  because only `areas/settings` may touch the `gyms` table.
* **Routes.** `GET` and `PUT /api/health/auto-update` (`autoUpdateContracts`, owners only through
  `integrations.manage`) read and change the switch. `available` is false on an install that serves several gyms,
  where no updater runs, and `PUT` answers 409 there.
* **The host's command.** `gym-app auto-update check` prints `restore=…` and, unless a restore holds the install,
  `setup=false` before the setup wizard has created the gym, or `setup=true`, `enabled=…`, `backups=…` and
  `timezone=…`. `gym-app auto-update record --at --result [--reason] [--from] [--to]`
  stores one attempt as an audit row (`health.auto_update.attempted`, target type `auto_update`), refused during a
  restore. `autoUpdateAttemptSchema` accepts each result only with the facts it can know: `up_to_date` the running
  version, `updated`, `rolled_back` and `failed` both versions and (for the last two) a reason, `skipped` a reason.
  Single-gym installs only. It is registered in `cli/index.ts`.
* **The tile.** `createAutoUpdateHealthProvider` reads the switch and the latest attempt. Off, or no attempt yet:
  not set up. Up to date or updated: healthy. Rolled back: warning. Failed (the rollback failed too): error.
  Skipped: a warning, or an error when the release itself was refused (bad signature, digest or manifest, or a
  patch that changes migrations); a night skipped while the switch was off reads as not set up once it is back on.
  An attempt older than 50 hours is a warning that names the timer. The message carries the reason
  (`locales/en/health/auto-update.json`).
