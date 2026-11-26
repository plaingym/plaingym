<!-- SPDX-License-Identifier: AGPL-3.0-only -->

**Accept bank payments** uses `PUT /api/settings/payments/bank-debits` with
`integrations.manage`, the current gym revision and `bankDebitsEnabled`. The
default is off. Enabling requires USD or CAD and writes `settings.bank_debits.changed`.
GET on the same resource returns the time of the most recent bank payment refusal
when it follows the last switch change. The switch turns bank payments on and off,
because Checkout Sessions name their methods and the Stripe Dashboard's per-method
setting doesn't apply; the Stripe account must have the method activated, and
Payments shows the refusal warning. The CAD go-live checklist also reminds the owner
about mandate emails (Stripe Dashboard → Settings → Business → Customer emails).

After a restore, a payment check counts only for the Stripe mode it read. The
report records `stripeMode` from the payments adapter; older reports without a
mode need a rerun before billing can be enabled with Stripe. Both credential save
paths audit their mode in the save transaction, which the billing gate reads
under the gym lock. Saving a mode the last clear report did not read also pauses
enabled billing in that transaction. Re-saving the checked mode keeps it on.
The adapter does not expose an account ID, so the report identifies only its mode.
Go live keeps the standard pending-attempt and refund guidance when it appends a
mode-change notice. The notice asks for a check before enabling billing without
claiming billing was previously enabled. Payments shows that same server message;
both sections share a checklist read, and a rerun updates both without a revision change.

Unreadable stored SMTP settings fall back to the install's service, or none.
The Email response reports that active source, `unreadable`, and `googleConfigured`;
the Google client is read only when the gym has stored SMTP settings of its own,
since only then do the removal check and the Google removal guidance use it, and
`googleConfigured` is false otherwise. Health names the unreadable SMTP value and
retains one parsed encryption key across polls, logging each unreadable value once.
Successful SMTP test audits commit with the settings save; a revision conflict
records no success. Failed tests still record their failure.

Settings hash navigation follows delayed section changes for at most four seconds,
and stops as soon as the user interacts, including a click.

Malformed install Google variables are returned as `installProblem` only in single
mode. A stored gym client remains in use and Health warns about the ignored
variables. Multi mode keeps the startup log only.

SMTP resolution also treats unreadable stored credentials as unconfigured, with
the same redacted logging; login and Google removal then use install SMTP if
available. Email removal still counts Google for the gym rather than checking the
owner's linked identity. The Email section states this and asks the owner to try
Google first. Each submitted Settings test writes `integrations.email_tested`
without credentials or recipients. A failed test's audit and response carry
`test: 'failed'` and `failure` (`connection`, `tls`, `authentication`, or
`sender_refused`). Neither includes the server's reply. The class comes from
transport error codes, response numbers and the reply's leading enhanced status
code only, and uses the stored port and security for a session timeout or a
refused connection on port 465.
Failed tests leave the saved settings unchanged. The audit records
`test: 'sent'` only with the save.
Real sends record the gym's email state (`email-status.ts`): every config from
`createSmtpResolver().config(gymId)`, the gym's own or the install's, carries a `report`
that writes a system `email.delivery_failed` audit row (`after: { failure, source }`: the
class and whose settings were used, `gym` or `install`, nothing else) when a send fails through the sending service (`emailServiceFailure`:
connection, TLS, authentication, or a refused sender address, never an unknown
outcome, a failure that never reached SMTP, or a refused recipient: a recipient
refused at `RCPT TO` with 550 or 554 counts only as the recipient's, while 530 at
any command reads as a login requirement) and that class isn't already shown, and
`email.delivery_recovered` when a send works after a recorded failure. Rows are
written only on a change, in a short transaction after the send; a send's report is
skipped when the email settings changed (saved, removed, or saved at setup step 5)
after its settings were resolved, and a failed record is logged and never changes
the send. `readEmailSendFailure` returns the newest failure
until a recovery, `integrations.email_saved`, `integrations.email_removed`, or setup
step 5 with settings saved (a skip, `test: 'not_sent'`, doesn't count) follows it. Changing
the install's `SMTP_*` settings takes a restart, which writes no audit row, so a failure
through them records a fingerprint of those settings as `settings`: an HMAC-SHA256 under
the app's encryption key of `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_FROM`,
`SMTP_USER` and `SMTP_PASS` (`installSmtpFingerprint` in `smtp.ts`), never the values.
It stands across restarts and app processes while the current fingerprint matches
(`installSettings`), and stops standing once the settings differ. One without a
fingerprint, written by an earlier version, stops standing once it is older than the app
process's start (`installSince`, default `processStartedAt`). A row without a `source`
is read as the gym's. `readEmailSendFailure` also returns the row's `source` (`gym` or
`install`). The Email section shows the failure as `lastSendFailure`, with its time, only
while mail goes through the settings it failed on (none when no settings are in use); a
refused login through the install's settings names the server's `SMTP_USER` and
`SMTP_PASS` on a single-gym install and whoever runs the install on a multi-gym one.
Removing an unreadable stored value is never refused, since it takes no sign-in
method away; its audit still records `source: 'gym'` for the stored value. Operator-managed refusals reload the
integrations and show the operator notice in place of the editable forms.

`checkIntegrationsEnvironment(mode, env)` exports the policy validation for early
boot: the runtime calls it in `prepare()` before any database connection is opened,
so an unknown `GYM_INTEGRATIONS` value stops the start there.

Unreadable Google clients are reported as `source: 'none'` and `unreadable: true`, with no stored ID or secret flag and both removal and replacement available. They do not count as a way in when removing email settings. Google reads and settings SMTP reads share `unreadable-secret.ts`: it remembers the last failed ciphertext per secret class, gym and encryption-key object, logging one redacted error until the stored value changes; no decrypted value is cached. Google audit source values still describe the stored configuration.

Both setup and Settings check a backup destination before generating a key using `backup-destination.ts`: list an unused snapshot prefix, then write, read back and delete a unique probe blob (`blobs/probe-<uuid>`), so credentials limited to the `snapshots/` and `blobs/` prefixes snapshots use pass and ones that can't write there don't; a probe whose cleanup failed is an unreferenced blob, which pruning removes without stopping. A refusal returns `destination: ['unreachable']` without saving anything. Backup status uses only complete snapshots at the current destination whose authenticated references name the current recipient; legacy reference lists without a recipient cannot establish that match.

General settings and booking rules use the gym revision for compare-and-set updates. Currency changes lock the gym row and are rejected when plans, charge types, class packs, discounts, memberships, invoices, or active bank accounts of the current currency's type (US bank accounts in USD, Canadian PADs in CAD) exist; currency foreign keys and the gym row lock also protect concurrent inserts. The record check is `assertCurrencyChangeable` in `currency-lock.ts`, which the setup wizard's gym details step runs too. Responses and audits use the same explicit safe projection and exclude credentials and opaque settings.

The module helpers take the existing server registry and inspect request context or job gym settings at execution time. The website definition registers its staff preparation routes through the module's `settingsRoutes` field, which the registry mounts without the gym's module switch; core and this area do not import it.

A new timezone, in setup, in a general settings save and in `gyms create`, follows one shared rule (`gymTimezoneSchema`): spaces around it are dropped (a pasted ` America/Vancouver` is accepted in all three), then `UTC` or a region form that `Intl` knows, stored in its canonical case (Temporal's identifier), so `america/vancouver` is stored as `America/Vancouver`. Links are kept as given (`US/Pacific` stays `US/Pacific`), because `Intl` resolves current names to retired ones (`Asia/Kolkata` to `Asia/Calcutta`, `Europe/Kyiv` to `Europe/Kiev`). Abbreviations (`PST`, `CET`) and `Etc/GMT±N` (its sign is inverted, and a region form exists for every offset) are refused. The general settings request validates `timezone` with that rule. A general or retry-schedule save that fails validation is a 400 whose `details` name every refused field by its path (`timezone`, `name`, `address.country`), each with a code: `invalid_timezone` for the zone, `invalid_retry_days` for the retry schedule, `unsupported_country` for any country that isn't a two-letter region the phone library supports (`UK`, `canada`, checked by the shared request schema for a general save, and refused by the setup wizard's gym step as a plain 400 `invalid_request` with no `details`; `GB` is the United Kingdom, and a stored country is read as it is), and `invalid` for any other; a body that supplies no change names no field, and a body that isn't JSON at all is a 400 `Request body must be JSON` with no `details`. The Gym details form sends the address only when one of its fields changed, so a stored country the rule refuses doesn't block other changes. The timezone is optional, and a save that leaves it out keeps the stored zone, whatever it is, as it was. A stored zone is never rewritten.

Gym creation reserves the gym and primary domain in an audited system transaction through `core/tenancy-bootstrap.ts`. The new gym ID scopes the audit in that transaction. A retry must match the original slug, hostname, owner email, name, timezone, and currency; unrelated existing gyms are rejected.

After reservation commits, `createOwnerService` provisions the identity and owner role together, then sends a gym-bound magic link outside the transaction. The default CLI uses this service directly and returns gym/user IDs and delivery status. A failure leaves a reservation that an identical retry can resume; uniqueness constraints prevent duplicate identities or owner roles. Delivery retries may resend a link. Staff invitation management is a separate service.

Email, Stripe and backups after setup (`integrations.ts`, `/api/settings/integrations`, `integrations.manage`, owners only) reuse the setup steps' parts and the gym revision. Nothing they return, audit or log holds an SMTP password, Stripe key, webhook signing secret, storage credential or private key; only the key-creation response shows the new private key, once, and is sent with `Cache-Control: no-store`. Email saves only after its test message is accepted (on a multi-gym install, only to SMTP ports 25, 465, 587 or 2525, so a tenant can't probe other services), and removal is refused while it would leave the signed-in owner no sign-in method. A new Stripe key is refused for another account or mode once the gym has Stripe customers, cards or card payments: after the permission probe, the new key must read at least one of up to seven of them (customers, PaymentIntents, charges or payment methods, all readable with the setup permissions); a 404 on every one means another account, and one stale ID can't block a change. The app's own references are checked first and, when there are any, alone: customers it linked (a `billing.customer.linked` or `link_campaign.customer_matched` audit names the household's customer), the latest attempt's customer, card payments and cards saved through Stripe; imported customer IDs and cards (written without asking Stripe, so possibly from another account or mistyped) are checked only when nothing else exists. A key in the other mode is refused (`mode_locked`; with no key stored, after a setup `skip` or settings that can't be read, the mode compared is the latest saved key's, `savedStripeMode`, while the app's own references exist, not for imported customer IDs and cards alone), with one way out: from test to live, a request with `clearTestData: true` (it needs the stored test key, so with none the owner saves the test key again, then switches) skips the account check and, once the live key has connected, clears the gym's test-mode references inside the save's transaction. It first locks the open and past-due invoices, which the charge runner locks to reserve an attempt, and is refused with `payments_in_progress` while a payment attempt is pending or processing, an invoice is processing, or a refund is pending. It clears only what the test key made: a household's `stripe_customer_id` when an audit shows the app linked that customer (`billing.customer.linked` from the customers service, or `link_campaign.customer_matched` naming it), audited as `billing.customer.unlinked`, as it does for each household with a customer creation reservation (one may be in flight with the test key); the unlink starts a new creation generation (`areas/billing/customers.README.md`). It revokes the cards saved through Stripe, and an imported card only when its household's customer is cleared. An import writes Stripe IDs without asking Stripe, so they may be the gym's live ones: imported customer IDs and their cards stay, and `testData` lists them as kept (`importedCustomers`, `importedCards`). It drops the Checkout sessions and reservations of open and past-due invoices (paid and void ones keep their completed session's ID), closes action-needed attempts as failed with their own decline code `test_cleared` (each audited as `billing.attempt.resolved`; they count as abandoned, never as a card decline), marks every card or bank-debit payment recorded through Stripe that isn't marked yet as test with the reference `Stripe test mode` (`stripeTestPaymentReference`; Stripe payments otherwise never have one), whatever its ID (it doesn't compare IDs with an earlier switch's audit), and closes the open disputes on the invoices of those payments (status `closed`, each audited as `billing.invoice.disputed` with `reason: 'stripe_test_cleared'`; the live key can't read or answer them), all in one `integrations.stripe_test_cleared` audit with the counts and the marked payment and disputed invoice IDs; invoices, refunds and attempts stay. Work already running waits for the save on the gym row (`holdGymSettings`): a charge reservation that resolved its provider before the switch reserves nothing and resolves it again, a refund reserved meanwhile is refused once its payment is marked (`test_payment`), and the dispute writer leaves a marked payment's dispute unrecorded. The shared `stripe-writes.ts` guard compares the switch snapshot read before provider resolution under that lock (the latest clear audit, the latest Payments save that changed the Stripe mode, so a mode change with nothing to clear also counts, or the latest setup Stripe step save that changed or removed a stored mode); webhook transactions, including invoice transitions and card collection, roll back stale test writes and the inbox finishes their event as skipped; a Stripe test-mode webhook event dispatched after the switch is finished with an audit and no Stripe call (`areas/billing/webhooks/inbox.md`). After the commit, the old test key expires the dropped Checkout and card setup sessions and cancels the action-needed PaymentIntents (the request waits at most 10 seconds for them; the rest finish after it, and failures are logged), and `retireStale` removes the old test endpoint. What a switch cleared then no longer ties the gym to an account, and it is marked rather than compared by time (IDs and clocks differ between app processes): its Stripe payments carry `Stripe test mode`, the cards it saved through Stripe are revoked (the imported cards it kept still count), and attempts don't count after a switch (a live attempt's customer and payment count instead). Customer creation, the charge runner and webhook writes use `stripeSwitchSnapshot` in `areas/billing/stripe-writes.ts`. Settings and readers that identify cleared test data use `latestTestSwitch`. Live to test stays refused while live references exist. While the gym has no Stripe settings and only imported customer IDs (none the app linked, and no attempts, card payments or cards: `importedCustomersOnly`), any account's key, in either mode, is accepted; a customer the app linked always needs the read; with a live key, Checkout later replaces an ID the account can't read (with a test key it refuses instead, since a live customer looks missing to a test key). A refund of a payment marked `Stripe test mode` is refused (`test_payment`): the live key can't refund it. GET returns `testData` (what the switch would clear, the imported references it keeps, the Stripe payments it marks and the open test disputes it closes, `disputes`) while the gym is in test mode with references, counted in SQL with the switch's own conditions (`integrations.query.ts`); a card setup page counts, and is expired by the switch, only when it was started within the last 24 hours, since Stripe expires a Checkout session by then. Backups exist only in single-gym mode outside demo mode: a new destination passes the probe above with its credentials first, then it and a new key wait in `gyms.settings.integrations.backup` (credentials encrypted) while snapshots keep the current ones, and activate only when the pasted private key matches; the blob key is kept, since snapshot reference lists are authenticated with it and a new one would stop pruning. Confirming queues one snapshot (`requestSnapshot`). Replacing the storage credentials (`PUT /api/settings/integrations/backups/credentials`) changes the stored access key ID and secret once that check passes, and also writes the same newly encrypted credentials into a waiting change for the same destination (same endpoint, region and bucket), audited as `integrations.backup_credentials_replaced` (with `pendingUpdated`, never the keys): a waiting change for another destination (endpoint, region or bucket) keeps its own keys, the destination, backup key, blob key, retention budget and snapshots stay, no snapshot is queued, and the next snapshot uses the new key. It is refused with `accessKeyId: ['not_configured']` before backups are set up. In demo mode the section is read-only.

When the test-to-live switch revokes a household's default card, its most recently
added kept active card becomes the default (`createdAt`, then ID descending),
using the same promotion as card removal. The revocation and
`billing.card.default_changed` audit commit together under the household lock.
A kept default stays unchanged; a household with no kept active card has no default.

On a multi-gym install email, SMS and payments are read-only for gym owners unless `GYM_INTEGRATIONS=gym` (`gymIntegrationsEditable` in `core/tenancy.ts`): GET reports it as `integrationsEditable`, and saving or removing email or SMS and saving a Stripe key answer 403 (`operator_managed`). Single-gym installs ignore the variable, and `integrationsEditable` is always true there.

SMS provider settings (`integrations.sms.ts`, PUT/DELETE `/api/settings/integrations/sms`)
also supply PATCH `/api/settings/integrations/sms/cap`: an integer from 1 to
100,000, default 1,000, using `integrations.manage`, the gym revision and an
`integrations.sms_daily_cap_updated` audit with the old and new cap and the new gym
revision. It saves through the shared integration save, like the provider changes.
This route is mounted by `createIntegrationsRoutes` and returns the shared gym settings.
The cap remains editable in a sandbox and on an operator-managed install: it changes no credentials.
Provider changes
share `integrations.manage`, the gym revision, sandbox refusal and operator policy.
GET returns only configured/unreadable status, account SID, auth kind and sender;
the provider base URL is included only in single-gym mode. Tokens and API key
secrets are never returned, logged or audited. Save checks the account without
sending, then tests only the typed, normalized `testTo` through the raw adapter
(member consent, switches and caps do not apply to an owner's test), prefixing
the text with the gym name. Both numbers are normalized with the gym's country. When the gym has no country (or a stored one the phone library doesn't support, read through `supportedCountry`), a From number must start with + and a test number without + takes the From number's calling code (`callingCodeOf`, `normalizePhoneWithCallingCode` in `@plaingym/shared/phone`); with a Messaging Service SID the test number must start with +. Network calls happen outside transactions. Each test
outcome is audited on its own (`integrations.sms_tested`, sent or failed), so a
text the provider accepted stays recorded even if the save then conflicts. Both
must succeed before an encrypted config is committed with its revision and the
`integrations.sms_saved` audit; failures preserve the previous config. Provider save and remove
use the shared integration save transaction and record the resulting revision in their audit.
A failed provider test logs `settings.sms_test_failed`. Alongside `time`, `level` and `event`, it records `errorName`, `providerStatus` (the acceptance,
or `suppressed`), `step` (`account` for the account check, `send` for the test text), `providerHttpStatus` and
`providerCode` (the provider's HTTP status and integer error code, each `null` when unknown or for a suppressed
result), never the provider's message, a credential, a number or the text. `smsTestFailure` names the cause from
the status and code, and the response carries it as `failure` only when it names one: `unreachable` (no response),
`authentication` (401, 403, or code 20003 or 20008), `trial_account` (572006, 21608), `opted_out` (21610), `sender`
(21212, 21606, 21659, 21660) or `recipient` (21211, 21408, 21612, 21614). The `integrations.sms_tested` audit stays
`{ test }`. Unexpected programming errors propagate as server errors. Remove
clears the config and writes `integrations.sms_removed`; with nothing stored it
answers 409 `not_configured`, like email.
Removal leaves the member-text switch on. Health warns when texts are on without a
readable provider; Go-live marks SMS not applicable when texts are off and no provider is configured.
Multi-gym installs accept only Twilio's URL; single-gym installs accept an HTTPS
Twilio-compatible base URL. `smsFactory` is an optional test transport override;
production defaults to `TwilioSms` with the saved credentials.

Google sign-in (`/api/settings/integrations/google`, same permission and revision) stores the gym's own OAuth client encrypted in `gyms.google_config_encrypted` (`google-login.ts`, secret class `google_config`). GET returns the source (`install`, `gym` or `none`), whether the form is offered (`editable`), the stored client ID and only whether a secret is set; the secret is never returned, audited (`integrations.google_saved` and `integrations.google_removed` record only the source) or logged. A save first checks the revision, then asks Google's token endpoint about the client outside any transaction (`requireGoogleClient`, as setup does): a client Google refuses answers 400 with the reason `google_rejected` and nothing is stored, and the save's reply carries `check` (`accepted`, or `unknown` when Google couldn't be asked). GET reports malformed install `GOOGLE_*` variables as `installProblem` (the variable and the reason), and the Health page's `google_login` tile shows the same (`areas/health/status.providers.ts`). A save replaces both values; removal is refused (`only_sign_in`) while it would leave the signed-in owner neither email links nor a password of their own. `createGoogleClientResolver` decides the client per request: the install's `GOOGLE_*` variables win in either mode (saves are then refused with `install_configured`), a single-gym install otherwise uses the stored client, and multi-gym and demo installs ignore the column (saves answer 404). An unreadable stored client counts as none and is logged without its value.

Email uses the gym's own SMTP settings first and the install's `SMTP_*` otherwise (`smtp.ts`). Setup stores a gym's settings with `encryptSmtpConfig` in `gyms.smtp_config_encrypted` as `{ host, port, security, from, username, password }`; `createSmtpResolver` decrypts them for login links and member email, and they never appear in responses or logs. On a multi-gym install it marks a gym's own settings `publicHostOnly`, as the Settings test message does, so `SmtpEmail` connects only to a public address (`infra/email/README.md`). A refused host is a failed test, indistinguishable from a name that doesn't resolve. The install's `SMTP_*` are the operator's and aren't marked.
