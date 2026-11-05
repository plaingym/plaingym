<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Self-hosting

This guide takes a gym from an empty server to a running install, and covers
backups, updates and day-to-day operation. One install runs one gym on one
hostname. Step-by-step guides cover [installing](install.md), [updating](updating.md),
[restoring](restoring.md), [importing](importing.md), [card re-collection](card-recollection.md),
the [member portal](member-portal.md), [going live](going-live.md) and [demos](demo.md).
For building images and the installer's internals, see
[`deploy/README.md`](../deploy/README.md); for every setting, see
[configuration.md](configuration.md).

## What you need

* **A server**: Ubuntu 24.04 or 26.04 LTS, amd64 or arm64, with 2 GB of RAM
  (running the whole stack on 1 GB isn't established). The installer adds 1 GB of
  swap if none is active.
* **A hostname** such as `gym.example.org`, with an A record (and an AAAA record,
  if you use IPv6) pointing at the server. Use a DNS-only record: a proxied record
  (for example Cloudflare's orange cloud) fails the installer's DNS check and the
  certificate request.
* **Open ports**: TCP 80 and 443, and your SSH port.
* **A PlainGym image** for the server's CPU architecture, as a version tag or
  digest, or a bundle file built with `deploy/test/prepare-bundle.ps1`. The server
  never builds the image.
* **An email sending service** (Postmark, Brevo, Amazon SES or similar), for sign-in
  links, receipts and reminders. Optional: without email, staff sign in with
  passwords and the app sends nothing.
* **A Stripe account**, to take card payments. Optional: without it, billing stays
  off and staff record cash and checks.
* **An S3-compatible bucket for backups** (Cloudflare R2, Backblaze B2, AWS S3,
  MinIO or similar), with an access key that can read, write, list and delete in
  it. Strongly recommended: updates take a backup first and refuse to run
  without backups.

## Install

Copy the deployment bundle to the server and, from its directory, run:

```sh
sudo sh install.sh --hostname gym.example.org --email owner@example.org \
  --image ghcr.io/plaingym/app:vX.Y.Z
```

`--email` is where the certificate authority sends notices about your certificate.
A bundle with the image inside installs the same way with `--image-archive`
instead of `--image`, and `deploy/bootstrap.sh` can fetch and check a bundle by
URL first (`deploy/README.md`, "One command from a bundle").

The installer first checks that the hostname resolves only to this server; if a
check fails, it stops before changing anything. Then it:

1. installs Docker, turns on the firewall (SSH, 80, 443), unattended OS security
   updates and swap;
2. writes `/opt/plaingym/.env` (mode 0600) with six independent random secrets;
3. starts Caddy, the app and PostgreSQL, waits for a valid certificate and a
   healthy app;
4. turns on automatic patch updates: a systemd timer (`plaingym-update.timer`)
   that installs patch releases each night (see [Updates](#updates));
5. prints a private setup link: `https://gym.example.org/setup#token=…`.

Re-running the same command is safe: it keeps `.env`, starts anything that
stopped and prints the setup link again. It refuses to change the hostname, email
or image; change the image with `update.sh`.

If the certificate never validates, check DNS, the firewall, and
`sudo docker compose logs caddy` in `/opt/plaingym`. Don't delete the database
volume to retry.

## Setup wizard

Open the setup link in a browser. The token in it (`SETUP_TOKEN` in `.env`) proves
you control the server; without it no one can create the owner or restore a
backup. If you lose the link, print it again:

```sh
cd /opt/plaingym
sudo docker compose exec -T app gym-app setup-link
```

The wizard's steps:

1. **Start fresh or restore a backup.** A restore needs the bucket, its
   credentials, the snapshot ID and your backup private key (see
   [Restore](#restore)).
2. **Owner account**: your name and email, and a password if the install has no
   email yet.
3. **Gym details**: name, timezone, address, billing currency and brand color.
   The currency can't change once billing data exists.
4. **What do you teach?** Choose content packs (rank systems, programs, class
   tags), or none. Everything stays editable.
5. **Your website**: use the built-in public website, or link to the site you
   already have.
6. **Email delivery**: your sending service's SMTP details. The wizard sends a test
   message and saves the settings only if it arrives. Follow your provider's SPF
   and DKIM instructions. Once email works, sign-in switches to emailed links
   (`AUTH_PASSWORD_LOGIN=auto`).

   An optional **Google sign-in** page follows: enter a Google OAuth client's ID
   and secret to let staff and members sign in with Google, or skip it (see
   [Google sign-in](configuration.md#google-sign-in)). The wizard skips the page
   when `.env` already sets Google.
7. **Payments**: a Stripe restricted key (see [Stripe](#stripe)), or skip.
8. **Backups**: the bucket and its credentials. The app generates a backup key pair
   and shows the private key **once**: download it, keep it somewhere safe off
   this server, and confirm. Or choose **Set up later**.
9. **Import or start fresh**: import members, households, memberships and history
   from CSV exports, or start empty.

After setup, billing and member emails are still paused. Turn them on in
**Settings → Go live** once its checklist is clear: payments configured, cards on
file for paid memberships, current waivers signed, email and backups set up.

The admin's **Settings** covers the gym's details, booking rules, billing rules,
currency, drop-in fee, go-live and Google sign-in. Its **Email, payments and backups** section
(owners only) changes what the wizard set up, or adds what was skipped, through
the same steps: see [After setup](#after-setup).

## After setup

Owners change email, Stripe and backups in **Settings → Email, payments and
backups**. Saved passwords, keys and the webhook signing secret are never shown
again, and every change is recorded in the audit log without them.

* **Email** shows the SMTP host, port, encryption and sender the gym uses, or that
  it uses the install's `SMTP_*` settings. New settings are saved only after a test
  email to an address you choose is accepted. **Remove** goes back to the
  install's settings, or to no email. Either change can switch how people sign in
  (`AUTH_PASSWORD_LOGIN=auto`: emailed links with email, passwords without); the
  page says how before you save. Removing email is refused while it is your only
  way to sign in (your account has no password).
* **Payments** shows the Stripe mode (test or live) and whether the webhook
  endpoint is registered. A new restricted key is checked and its webhook endpoint
  kept or replaced exactly as in setup. Once any household has a Stripe customer,
  a card is saved or a card payment exists, the new key must be for the same Stripe
  account and the same mode: those customers, cards and payments belong to it.
  To go live after trying billing in test mode, paste the live key: the page lists
  what switching clears and what stays, and switches only after you confirm. Once
  the live key is checked, the Stripe customers and saved cards made in test mode
  and the open Stripe payment and card pages are cleared (members get a live
  customer the first time they pay or save a card, and their links keep working);
  invoices stay, and test card payments stay on them, marked "Stripe test mode"
  (they can't be refunded: no real money moved). Imported Stripe customer IDs and
  cards stay too, since they may be your live ones. The switch waits while a card
  payment or refund is still being processed. Once live customers, cards or
  payments exist, a test key is refused. If you skipped Stripe in setup and
  imported households with Stripe customer IDs, a key from any account is
  accepted. With a live key, a customer the account can't read gets a new one the
  first time that member pays or saves a card; a test key can't read live
  customers, so with one, those members' payment and card links aren't available.
* **Backups** sets up backups skipped in setup, or moves them to another bucket,
  or replaces the backup key. As in setup, the app shows a new private key **once**,
  and nothing changes until you paste it back to prove you saved it; until then,
  snapshots keep using the current bucket and key. A new bucket is checked with its
  credentials before the key is made. A snapshot with the new settings starts
  right after you confirm. Snapshots under the old key stay readable only with
  that key until retention removes them, so keep the old key until then. After a
  move, the app no longer manages the old bucket: its snapshots stay there until
  you delete them. The section also shows the last restorable
  snapshot and the retention budget.

Owners also set up, replace or turn off Google sign-in in **Settings → Google
sign-in**, which shows the redirect URI to register with Google. The client secret
is never shown again (only that one is set), a change takes effect on the next
sign-in, and the audit log records each change without the client ID or secret.
Turning it off is refused while Google is your only way to sign in. When `.env`
sets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, the section says so and offers
no form: see [Google sign-in](configuration.md#google-sign-in).

## Stripe

Each gym uses its own Stripe account, and payments go straight to it. In the
Stripe dashboard, create a restricted key with:

| Permission | Access |
| :--- | :--- |
| Customers | Write |
| Payment Intents | Write |
| Checkout Sessions | Write |
| Payment Methods | Write |
| Charges and Refunds | Write |
| Webhook Endpoints | Write |
| Setup Intents | Read |
| Events | Read |
| Disputes | Read |

Paste it into the wizard's payment step (or, later, **Settings → Email, payments
and backups**). The app checks each permission without
moving money (a missing one is named), then registers its webhook endpoint at
`https://gym.example.org/webhooks/stripe`. Use a test key (`rk_test_…`) to try
billing first; a live key (`rk_live_…`) takes real payments, and replaces the
test key in **Settings → Email, payments and backups** once you confirm clearing
the test data. Members enter cards only on Stripe's hosted pages.

## Sign-in

* **With email** (the gym's own SMTP, or the install-wide `SMTP_*` settings), staff
  and members sign in with a link emailed to them.
* **Without email**, staff sign in with a password. Once the gym has email,
  passwords stop working and everyone signs in with emailed links
  (`AUTH_PASSWORD_LOGIN=auto`). To keep passwords after email is set up, put
  `AUTH_PASSWORD_LOGIN=on` in `.env` and run `sudo docker compose up -d`. `off`
  turns passwords off even without email, which leaves no way to sign in until
  the gym has email (see [configuration.md](configuration.md)).
* **Locked out?** Reset the owner's password on the server:

  ```sh
  cd /opt/plaingym
  sudo docker compose exec -T app gym-app auth reset-password owner@example.org
  ```

  Owners and admins reset other staff passwords in the admin.

## Backups

With backups set up, the app takes an encrypted snapshot of the database and all
uploaded files every hour and uploads it to your bucket. Snapshots are encrypted
with [age](https://age-encryption.org) to your backup key's public half before
they leave the server, so neither the server nor the bucket's provider can read
them; only your private key can.

Retention keeps 24 hourly, 7 nightly and 4 weekly snapshots, plus up to two
pre-upgrade snapshots from the last 30 days, within an 8 GB budget. Files that
didn't change are stored once and shared between snapshots. The **Health** page
in the admin shows the last successful backup and any failure.

**Keep the private key safe.** It is shown once, in setup or when you replace it
under **Settings**. Without it, the backups can't be opened by anyone.

### Restore

Restore onto a fresh install:

1. Install as above, with the same or a new hostname.
2. Open the setup link and choose **Restore a backup**.
3. Enter the bucket, its credentials, the snapshot ID (the folder name under
   `snapshots/` in the bucket) and your backup private key.

The restore verifies the snapshot, loads the database and files, and re-encrypts
the stored secrets for the new install. Billing stays paused until a
reconciliation with Stripe finishes and the owner turns it back on under
**Settings → Go live**.

The same restore runs from the command line with
`gym-app restore <snapshot-id> --config <file>`, where the file is a private JSON
file holding the bucket details and the path to the private key
(`apps/server/src/areas/health/backups.protocol.md`). An interrupted restore
resumes when the app restarts.

## Updates

Releases are numbered `vX.Y.Z`. A patch release (only Z changes) holds fixes and
never changes the database; a minor or major release can.

### Patch releases install themselves

Each night the server installs the newest patch release of the version it runs:
from 1.2.3 it takes 1.2.4 or 1.2.5, never 1.3.0. The installer's timer runs
`update.sh --patch` once a night between 02:00 and 05:00 in the gym's timezone.
It:

1. asks the app whether automatic updates are on and backups are set up;
2. finds the newest patch release and checks its signed release manifest and the
   image it names, so it only ever installs an image the project published;
3. takes a pre-upgrade backup, starts the new version and checks that it stays
   healthy for a minute;
4. goes back to the previous version if the new one doesn't start or isn't healthy.

The **Health** page's **Automatic updates** tile shows the last night's result:
up to date, updated, rolled back, or skipped and why (for example, backups that
aren't set up yet: without a backup it changes nothing). Owners turn automatic
patch updates off, or on again, in **Settings → Updates**; they are on by default.
To run tonight's check at once, for example after setting up backups:

```sh
sudo /opt/plaingym/update.sh --patch --now
```

### Minor and major releases

Once a day the app reads the newest release from GitHub's public releases list (no
token, nothing about your install is sent) for the repository in `RELEASE_REPOSITORY`,
the one the updater follows (`plaingym/plaingym` unless you set another). When a newer minor or major version is
out, owners and admins see an "Update available" banner with a link to the changelog,
and the Health page's **Available update** tile shows the running and latest versions.
A newer patch release raises no banner while the nightly update is expected to install
it. It does raise the banner when that update won't happen: automatic updates are
off, no nightly check has run for two days since the last one (the timer stopped), or the
last check for that release skipped, rolled back or failed. The banner and the tile say
why. With automatic updates off or the timer stopped, turn them on or fix the timer, or
install the release by hand, as below. When the updater refused the release on purpose
(its signature, image or database changes), don't install it by hand: wait for a fixed
release ([updating.md](updating.md#patch-releases-automatic)). A fresh start shows
nothing until the first answer has arrived, a moment later; if GitHub can't be reached
the last answer is kept and the check retries within the hour (the Health page's tile
says when it couldn't be read). A development build isn't a release and never asks.
`UPDATE_CHECK=off` in `.env` stops it (`docs/configuration.md`).

Update to a new minor or major release with:

```sh
cd /opt/plaingym
sudo ./update.sh ghcr.io/plaingym/app:vX.Y.Z
```

The updater:

1. pulls the new image while the app keeps running;
2. stops the app and takes a pre-upgrade backup. If backups aren't set up, it
   says so ("Backups are not set up: set them up in Settings → Email, payments
   and backups, then run the update again"), changes nothing and restarts the current version;
3. starts the new image, which applies its database migrations before it reports
   healthy;
4. records the new image in `.env` only once the new version is healthy.

If the new version fails to start, the updater restarts the previous image. Keep
previous images on the server until you are sure of an update. Releases change the
database only by adding to it (columns are dropped a release after they stop being
used), so the previous version keeps working against the migrated database, and
patch releases (x.y.Z) never change the database. Minor and major releases wait
for you to run the updater.

### Public website

**Settings → Gym details → Enable gym website** turns the built-in website on or
off. While it's on, `/` is its home page, with pages for programs, the weekly
schedule (with this week's cancelled, one-off and moved classes), memberships (the active plans, with "+ tax" where tax is added on top),
coaches (staff profiles marked **Show on the public website**) and location and
contact, plus a sitemap and `LocalBusiness` structured data for search engines.
**Settings → Website** sets the logo, the primary and accent colors, up to eight
photos, a tagline, an about text and a public phone number and email. The logo and
primary color also brand `/join`, `/trial` and `/drop-in`. With the website off,
`/` sends visitors to the member portal and the website's other pages answer 404;
`/join`, `/trial`, `/drop-in` and the portal work either way.

## Day to day

| Task | How |
| :--- | :--- |
| App logs | `sudo docker compose logs app` (one JSON object per line, rotated by Docker) |
| Access log | Off by default; `CADDY_ACCESS_LOG=stderr` in `.env` turns it on (`deploy/README.md`, "Access log") |
| Health | The admin's **Health** page: last backup, email, Stripe webhooks, charge runs, disk space, failed jobs, the running version and the last automatic update |
| Automatic updates | On by default; owners switch them in **Settings → Updates**. The timer's log: `journalctl -u plaingym-update` |
| Restart | `sudo docker compose up -d` in `/opt/plaingym` |
| Replay a Stripe event | `sudo docker compose exec -T app gym-app replay --gym <gym-id> <event-id>` |
| Replace the encryption key | `sudo ./rotate-key.sh` in `/opt/plaingym` (below) |

Run `docker compose` commands from `/opt/plaingym`. Everything the gym needs lives
in the Docker volumes and `.env`; keep a copy of `.env` somewhere safe, since it
holds `APP_ENCRYPTION_KEY`. Backups also carry that key, encrypted to your backup
key.

### Rotating the encryption key

`APP_ENCRYPTION_KEY` encrypts the secrets stored in the database: the Stripe key,
the email password, the backup storage keys, a Google sign-in client and the
gym's QR key. Replace it when a copy of it may have left your hands: a copy of
`.env` or of the whole server (a disk image, a snapshot at your provider) went
somewhere it shouldn't, or someone who had root on the server no longer should.
Never edit it in `.env` by hand: the stored secrets would no longer open.

```sh
cd /opt/plaingym
sudo ./rotate-key.sh
```

The app stops for a few seconds while every stored secret is re-encrypted with a
new key, then starts again with it, and `.env` then holds the new key. Keep a copy
of the new `.env` somewhere safe and delete old copies. Backups taken from now on
carry the new key; older backups still restore, with the key they carry. A file
download link or a join a visitor is in the middle of stops working; starting it
again works.

If it stops partway (a lost connection, a reboot), run it again: it finishes the
same rotation. If it says a stored secret opens with neither key, nothing was
changed; remove that setting in the admin and enter it again, then rerun.

A new key protects what is stored from now on. If a copy of the database may have
left together with the old key, also replace the credentials themselves: a new
Stripe restricted key, a new email password, new backup storage keys and a new
Google client secret.

## Running several gyms

`TENANCY=multi` serves several gyms, each on its own hostname, from one install.
It requires an S3 bucket for uploads and install-wide SMTP, uses emailed sign-in
links only, has no in-process backups, and creates each gym with
`gym-app gyms create`. The installer sets up single-gym installs only; the demo
deployment (`deploy/demo/README.md`) is an example of a multi-gym install.
