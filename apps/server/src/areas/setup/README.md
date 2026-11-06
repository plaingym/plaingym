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

The optional Google page after the email step (`PUT /api/setup/google`, contract step 5)
stores the gym's own OAuth client with `encryptGoogleConfig` (`settings/google-login.ts`)
in `gyms.google_config_encrypted`, under the revision, and audits `setup.google_saved`
with neither value. It needs step 5 complete and changes no step; skipping it sends
nothing (the wizard remembers the skip for the browser session). It is refused with
`install_configured` when the install's `GOOGLE_*` variables are set, which win.

Backup setup first probes the destination through `settings/backup-destination.ts`
(list, write, read and delete under the gym's prefix), refusing with `unreachable`
without saving a key if any operation fails. It returns a new private identity once, stores only its public recipient,
and activates the destination only after the owner pastes the matching identity.
The saved fields are read directly by `loadBackupConfig`; the default budget is 8 GB.
Credential values never enter progress or audits.
**Set up later** explicitly finishes without backups, clears any unconfirmed
destination, and leaves the health tile at not configured until the owner adds
them in Settings.

Email, Stripe and backups stay changeable after setup through
`areas/settings/integrations.ts`, which shares these steps' parts rather than
copying them: `sendSmtpTest` and `storedSmtpFromRequest` (`settings/smtp.ts`),
`createStripeConnection` (the key probe and webhook endpoint lifecycle, in
`stripe-step.ts`), and `backup-key.ts` (key pair, key check, stored destination,
blob key).

Restore runs through `RestoreService`, outside the HTTP activity lease. The small
external setup journal stores the random polling ID, snapshot ID, and safe status;
it never stores credentials or private identities. Polling can recognize completion
after maintenance resumes a verified restore. Billing remains paused.

The payment step supports skipping configuration. The finish handler currently
accepts a fresh start. Both use the shared setup contracts.
