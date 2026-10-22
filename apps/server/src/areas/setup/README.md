<!-- SPDX-License-Identifier: AGPL-3.0-only -->

`/setup` works before a tenant exists. Public setup routes check single mode and the
install's gym state. All public actions and restore polling also require the
installer's `SETUP_TOKEN` in `X-Setup-Token`; only setup status stays open.
Later steps require the original owner's session. Progress
lives in `gyms.settings.setup` and uses the gym revision. Completed setup is closed.

Owner creation reuses `reserveGym` and `createOwnerService`. Owner creation and
restore reserve the same unique slug, preventing concurrent bootstrap operations
across app processes. Failed backup verification removes only its own reservation.

Pack application and progress share one short transaction. SMTP sends its test
outside a transaction and saves encrypted settings only after successful delivery.
Skipping SMTP keeps the existing gym and install configuration.

Backup setup returns a new private identity once, stores only its public recipient,
and activates the destination only after the owner pastes the matching identity.
The saved fields are read directly by `loadBackupConfig`; the default budget is 8 GB.
Credential values never enter progress or audits.
**Set up later** explicitly finishes without backups, clears any unconfirmed
destination, and leaves the health tile at not configured.

Restore runs through `RestoreService`, outside the HTTP activity lease. The small
external setup journal stores the random polling ID, snapshot ID, and safe status;
it never stores credentials or private identities. Polling can recognize completion
after maintenance resumes a verified restore. Billing remains paused.

The payment step supports skipping configuration. The finish handler currently
accepts a fresh start. Both use the shared setup contracts.
