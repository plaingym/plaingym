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
Each submitted test records `setup.email_tested` without credentials or the
recipient. A failed test's audit and response carry `test: 'failed'` and `failure`
(`connection`, `tls`, `authentication`, or `sender_refused`). Neither includes
the server's reply. The class comes from transport error codes, response numbers
and the reply's leading enhanced status code only, and uses the stored port and
security for a session timeout or a refused connection on port 465. A delivered test records `test: 'sent'` in the transaction
that saves the settings. If the save loses the revision check, it records
nothing. Step 5 completion records `test: 'sent'` or `'not_sent'`, so skipping
cannot replace the Health tile's last test time.
Step saves, Google saves and decisions share the locked owner, preceding-step
and revision checks; Google saves and decisions do not complete a step.
The gym details step refuses a currency change with `conflict` on the same records
Settings does, under the gym row lock (`assertCurrencyChangeable` in `settings/currency-lock.ts`).

The optional Google page after the email step (`PUT /api/setup/google`, contract step 5)
stores the gym's own OAuth client with `encryptGoogleConfig` (`settings/google-login.ts`)
in `gyms.google_config_encrypted`, under the revision, and audits `setup.google_saved`
with neither value. It needs step 5 complete and changes no step. Once the owner, step
and revision check out, and before any transaction, `requireGoogleClient` asks Google's
token endpoint about the client (`checkGoogleClient` in `infra/auth/google.ts`, a
made-up authorization code, with a timeout): `invalid_client` refuses the save with
the reason `google_rejected`, `invalid_grant` answers `check: 'accepted'`, and any
other answer or a network failure saves with `check: 'unknown'`. It is refused with
`install_configured` when the install's `GOOGLE_*` variables are set, which win.

`PUT /api/setup/decisions` records the owner's decisions in the setup progress,
audited as `setup.decision_recorded`, without changing a completed step:
`skip_google` (after step 5) and `backups_later` or `backups_now` (after step 6).
Status reports them as `googleSkipped` and `backupsLater`, and with backups set up
later and step 7 the first unfinished one, `currentStep` is 8, so a reopened wizard
resumes past both.

The Stripe step (`PUT /api/setup/stripe`, `stripe-step.ts`, step 6) saves a restricted
key (or `skip`, which removes stored credentials) under the revision and audits
`setup.stripe_configured` with `before: { mode }`, the mode stored when the save locked
the gym row (`null` without one), and `after` with the saved mode (`null` on skip),
the endpoint ID and whether it was reused. Until setup finishes the owner can come
back to rotate or remove the key, or change its mode while the gym holds no Stripe
references (below), so the billing write guard
(`stripeSwitchSnapshot`, `areas/billing/stripe-writes.ts`) counts a setup save that
changed or removed a stored mode as a switch, as it does a mode-changing Payments
save: billing work that read the snapshot before it writes nothing with the old key.
A first save, a same-mode key rotation and a setup audit without `before` don't count.

A restore can bring Stripe customers, cards and card payments into an unfinished
wizard, so while the gym holds them the step checks a new key as the Payments save
does (`stripeReference`, `importedOnly` and `readsStripeReference` in
`settings/integrations.query.ts`): with a key stored, one in the other mode is refused with a 400 and
`restrictedKey: ['mode_locked']`, and a same-mode key must read one of them, checked
after the permission probe and before the endpoint is registered (otherwise a 400 with
`account_locked`). A save that finds references recorded while the key was checked
fails with a conflict. Setup offers no switch from test to live: the owner finishes
setup and switches in Settings → Payments. With no stored key (a first save, or one
after `skip`), customer IDs on households alone (no attempts, card payments or cards,
whether imported or linked by the app) tie the gym to no account, so a key in either
mode is accepted without a read; `skip` is never checked.

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
it never stores credentials or private identities. A failed status carries a cause class
(rejected credentials, a missing bucket or snapshot, an unreachable endpoint, a wrong or
invalid key, a damaged or unreadable snapshot, an interrupted or unstarted restore) and
whether a verified restore is staged, never upstream error text. Polling can recognize completion
after maintenance resumes a verified restore. Billing, member emails and member texts remain
off; backup pruning stays held until an owner confirms the old server is gone
in Settings or Health.

The payment step supports skipping configuration. The finish handler currently
accepts a fresh start. Both use the shared setup contracts.
