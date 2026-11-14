<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Configuration

PlainGym reads its configuration from environment variables. A self-hosted
install keeps its values in `/opt/plaingym/.env` (mode 0600), which the installer
writes. Gym settings are not environment variables: the owner sets email, Stripe
and backups in the setup wizard (and changes them later in the admin's
**Settings → Email, payments and backups**), and the gym's details, booking and
billing rules in the admin's **Settings**. They are stored in the database, encrypted where
secret.

Settings opens with Gym details and a section menu. Gym details contains the
single brand-color control; Website links back to it. The advanced logo setting
is a storage reference for an existing upload. Use Website to upload a logo.

`deploy/compose.yaml` has no `env_file`: the app container gets only the variables
its `environment:` block names. From `.env` it passes `GYM_HOSTNAME`, the `SMTP_*`
settings, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, `SOURCE_URL`, `APP_ENCRYPTION_KEY`, `AUTH_SECRET`, `SETUP_TOKEN`,
`POSTGRES_DB`, `APP_PASSWORD`, `MAINTENANCE_PASSWORD`, `NODE_OPTIONS`, `TRUST_CLOUDFLARE`,
`AUTH_PASSWORD_LOGIN`, `RATE_LIMIT_PER_MINUTE`, `UPDATE_CHECK`, `RELEASE_REPOSITORY` and `DATABASE_POOL_MAX` (the last
five with their defaults when unset or empty); it fixes
`NODE_ENV`, `HOST`, `PORT`, `TENANCY=single`, `TRUST_PROXY`, `DATABASE_URL`,
`MAINTENANCE_DATABASE_URL`, `UPLOADS_DIR` and `BACKUP_STAGING_DIR` itself; and it
reads the Compose and Caddy variables at the end of this page. The other variables
here (`PUBLIC_ORIGIN`, `PACKS_DIR` and `UPLOADS_S3_*`) are read by the server but
not passed by the shipped Compose file, so setting them in `.env` has no effect on
a standard install. The app reads an empty value as a value, not as unset, so
they can't be passed with an empty default; and a single-gym install is served
only at `https://GYM_HOSTNAME` and keeps its uploads on its data volume, where
backups and restores expect them. They apply when you run the server some other
way, such as in development or with your own Compose file.

After changing `.env`, run `sudo docker compose up -d` in the install directory.
The app checks its configuration on start and refuses to start with a clear
message when a value is missing or invalid. The Google sign-in variables are the
exception: a malformed one turns off only Google sign-in from `.env` (see below).

A test (`apps/server/src/core/configuration.docs.test.ts`) fails when the server
or the image's start-up scripts read a variable, or `deploy/compose.yaml` uses
one, that this page doesn't list. `pnpm verify` always runs the documentation tests,
and the Repo compliance workflow runs them even for Markdown-only changes.

## Required

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `APP_ENCRYPTION_KEY` | none | 32 random bytes as 64 hex characters (`openssl rand -hex 32`). Encrypts the secrets stored in the database. Backups carry it, encrypted to the owner's backup key, so a restore can recover it; without it or a backup, stored Stripe, SMTP and backup credentials are lost. Never change it by hand: `rotate-key.sh` replaces it and re-encrypts the stored secrets ([self-hosting.md](self-hosting.md#rotating-the-encryption-key)). |
| `NEW_APP_ENCRYPTION_KEY` | none | Set only by `rotate-key.sh` for the one container that re-encrypts the stored secrets: the key replacing `APP_ENCRYPTION_KEY` (64 hex characters). Never put it in `.env` ([self-hosting.md](self-hosting.md#rotating-the-encryption-key)). |
| `AUTH_SECRET` | none | At least 32 characters. Signs sessions. Changing it signs everyone out. |
| `SETUP_TOKEN` | none | At least 32 characters. Proves control of the server when creating the first owner or restoring a backup; the setup link carries it. Print the link with `gym-app setup-link`. |
| `DATABASE_URL` | none | The `app` role's connection URL. Compose builds it from `APP_PASSWORD` and `POSTGRES_DB`. |
| `GYM_HOSTNAME` | none | The gym's hostname, such as `gym.example.org`. Caddy requests its certificate, and the app builds login links and checks request origins with `https://` plus this name. Single-gym mode needs it or `PUBLIC_ORIGIN`. |

## Address and network

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `PUBLIC_ORIGIN` | `https://` + `GYM_HOSTNAME` | The origin browsers use, when it isn't `https://GYM_HOSTNAME` (development sets the Vite server's origin). Scheme, host and port only. |
| `HOST` | `127.0.0.1` | The address the server listens on. Compose sets `0.0.0.0` inside the container. |
| `PORT` | `3000` | The port the server listens on. |
| `TRUST_PROXY` | unset | `true` makes the last `X-Forwarded-For` entry the client address (for rate limits and sign-in). Set only when a reverse proxy is the app's only peer, as Caddy is in Compose. |
| `TRUST_CLOUDFLARE` | unset | `true` (written by the installer, and by the demo installer, when the hostname is proxied by Cloudflare) reads the client address from `CF-Connecting-IP` when the address the trusted proxy forwarded is in Cloudflare's published ranges (`deploy/cloudflare-ranges.txt`); from any other address the header is ignored. Needs `TRUST_PROXY=true`. Any other value leaves it off. See [install.md](install.md#behind-cloudflares-proxy-recommended) and its limits in [security-model.md](security-model.md). |
| `PLAINGYM_ORIGIN_NONCE` | unset | Written by the installer: a random value Caddy serves at `/.well-known/plaingym-origin`, which the installer fetches through the hostname before printing the setup link. Not a secret. |
| `SOURCE_URL` | `https://github.com/plaingym/plaingym` | Where the "Source code" link points (AGPL section 13). A modified install must point it at its own source. |

## Database

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `MAINTENANCE_DATABASE_URL` | none | The `maintenance` role's connection URL, for migrations, backups and restore. Single-gym installs give it to the app container; multi-gym installs give it only to the one-shot `migrate` service, and the app refuses to start in production if it is set. |
| `PGHOST` | `postgres` | The database host the image's start-up scripts wait for and prepare roles on, before the app connects with `DATABASE_URL`. Change it with the URLs when PostgreSQL runs elsewhere. |
| `PGPORT` | `5432` | The database port the image's start-up scripts use, as `PGHOST`. |
| `DATABASE_POOL_MAX` | `8` | The app's connection pool, 1 to 100. The default fits the shipped PostgreSQL settings (`max_connections=20`), which leave about one connection spare beside the app's sign-in pool, its backups and an update's snapshot; a larger pool there can make backups or that snapshot fail with too many connections. |
| `POSTGRES_DB` | `plaingym` | The database name. |
| `POSTGRES_PASSWORD` | none | The PostgreSQL bootstrap superuser's password. Used only to create the database and roles on first start. |
| `APP_PASSWORD` | none | The `app` role's password. |
| `MAINTENANCE_PASSWORD` | none | The `maintenance` role's password. |

Passwords must be URL-safe (the installer uses hex). Changing one in `.env` doesn't
change an existing database: the roles keep the password they were created with.

## File storage

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `UPLOADS_DIR` | none | Where uploads and exports are stored on disk. The server needs it unless `UPLOADS_S3_BUCKET` is set, but the image's single-gym start-up (the restore check before migrations) always requires it. Compose uses `/var/lib/plaingym/uploads` on the app's data volume. |
| `UPLOADS_S3_BUCKET` | unset | Store uploads in this S3-compatible bucket instead of on disk. Required in multi-gym mode. |
| `UPLOADS_S3_ENDPOINT` | AWS | The bucket's endpoint, for S3-compatible providers (Cloudflare R2, MinIO, Backblaze B2 and others). For AWS China, set it explicitly (for example `https://s3.cn-north-1.amazonaws.com.cn`) along with `UPLOADS_S3_REGION=cn-north-1`, so signed image URLs and the browser's image allowlist use the same origin. |
| `UPLOADS_S3_REGION` | `us-east-1` without an endpoint; `auto` with one | The bucket's region, used for both the S3 client and the browser's image allowlist. Set this to the bucket's region for AWS S3 outside `us-east-1`; `auto` suits most S3-compatible providers with `UPLOADS_S3_ENDPOINT`. |
| `UPLOADS_S3_ACCESS_KEY_ID` | unset | Access key for the bucket. Without the key pair, the SDK's default credential chain is used. |
| `UPLOADS_S3_SECRET_ACCESS_KEY` | unset | Secret key for the bucket. |
| `PACKS_DIR` | bundled | A directory of content packs (rank systems, programs, class tags) to use instead of the bundled `packs/`. |

## Backups

Backups are set up in the setup wizard's backup step, or later (and changed) in
**Settings → Email, payments and backups**, single-gym mode only: the destination
bucket and its credentials are stored encrypted in the database, not in `.env`.
Updates refuse to run until backups are set up, and automatic patch updates skip
each night until then (see [self-hosting.md](self-hosting.md#updates)).

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `BACKUP_STAGING_DIR` | unset | Local scratch space where a backup is written and encrypted before upload, and where a restore is unpacked. Compose uses `/var/lib/plaingym/staging`. Single-gym mode only, and the image's single-gym start-up (the restore check before migrations) requires it; multi-gym mode ignores it. A server run outside the image without it has no backups or restore. |

Backups use the key created in the setup wizard or in **Settings**. Installs made
by earlier versions have an empty `BACKUP_RECIPIENT` line in `.env`; nothing reads it.

## Email

A gym's own SMTP settings, entered in the setup wizard or in **Settings → Email,
payments and backups**, take precedence over these install-wide values; removing
them there falls back to these. Use a sending service (Postmark, Brevo, Amazon SES or
similar): mail sent directly from a server usually lands in spam.

In multi-gym mode gym owners change email and payments only when
`GYM_INTEGRATIONS=gym`; see [Tenancy and demo](#tenancy-and-demo). A gym's own SMTP server there must
resolve only to public addresses, whichever way the variable is set. The check uses
cancellable A and AAAA DNS queries with a ten-second deadline; it does not read the
hosts file. Single-gym installs retain system lookup support for hosts-file names.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `SMTP_HOST` | unset | The SMTP server. Without it (and without a gym's own settings), no email is sent and password sign-in is used. Multi-gym mode requires it. |
| `SMTP_PORT` | `587` | The SMTP port. |
| `SMTP_SECURITY` | `starttls` | `starttls`, `tls` (implicit TLS, usually port 465) or `plain` (development only). |
| `SMTP_FROM` | none | The sender address. |
| `SMTP_USER` | unset | SMTP user name. |
| `SMTP_PASS` | unset | SMTP password. |

## Sign-in and limits

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `AUTH_PASSWORD_LOGIN` | `auto` | `auto`: password sign-in only for a gym with no email set up, magic links otherwise. `on`: always offer passwords. `off`: never (required in multi-gym mode); a single-gym install without email then has no way to sign in. |
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests per minute per gym and client address before the app answers 429, from 1 to 100,000. A single-gym install counts them before looking the gym up, so requests that would get a 404 (before setup, say) count too. Sign-in, kiosk PINs and CSP reports keep their own limits; sign-in's, per client address and per account, have no setting (`security-model.md`, Sign-in). |
| `UPDATE_CHECK` | `on` | `off` stops the app asking GitHub once a day for the newest release (the "Update available" banner and the Health page's update tile), for an install that must not call out; so does any value other than `on`, `true` or `1`. It sends no token and no data about the install. A multi-gym install never checks. The banner reads the releases of `RELEASE_REPOSITORY` (see [Automatic patch updates](#automatic-patch-updates)). |
| `GOOGLE_CLIENT_ID` | unset | The client ID of a Google OAuth client. With `GOOGLE_CLIENT_SECRET`, turns on **Sign in with Google** for staff and members (see below), and wins over a client the owner entered in the app. Set both or neither; an empty value counts as unset. A malformed pair (only one set, a space or line break in a value, or a value over 512 characters) doesn't stop the app: it starts without them and says which variable is wrong and why (see below). Ignored in demo mode. |
| `GOOGLE_CLIENT_SECRET` | unset | That client's secret. |

### Google sign-in

Google sign-in is optional. Its OAuth client comes from one of two places:

* **In the app (single-gym installs).** The owner enters the client ID and secret in
  the setup wizard's optional Google page, after the email step, or later in
  **Settings → Google sign-in**. The app stores them encrypted with
  `APP_ENCRYPTION_KEY`, and a save or removal applies to the next sign-in, with no
  restart. The secret is never shown again: the section shows the client ID and
  that a secret is set, and a change replaces both values or turns Google sign-in off.
* **In `.env` (either mode).** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. When
  set, they win: **Settings → Google sign-in** then says the install's configuration
  sets Google and offers no form, and the wizard skips its Google page. This is the
  only source in multi-gym mode, where a gym owner never enters OAuth credentials.
  When the pair is malformed (only one of the two set, a space or line break in a
  value, or a value longer than 512 characters), the app still starts, without that
  client: it logs `auth.google_environment_invalid` once, naming the variable and the
  reason but never the value. On a single-gym install the **Google sign-in** tile
  and Settings report the problem until you correct `.env` and restart. A stored
  gym client is used meanwhile, and Health reports it in use with a warning.
  On a multi-gym install only the startup log reports malformed variables.

Before saving a client entered in the app, the wizard and Settings ask Google's token
endpoint about it with a made-up authorization code. If Google says it doesn't know
the client ID and secret, nothing is saved and the form says so. If Google can't be
reached or gives another answer, the client is saved with a warning that it couldn't
be checked. Google checks the redirect address only at a real sign-in, so after
saving, sign out and sign in with Google once.

Without a client the sign-in page shows no Google button. To set one up:

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an OAuth client of type **Web application** (set up the OAuth consent
   screen first if asked).
2. Under **Authorized redirect URIs**, add `https://<gym hostname>/api/auth/callback/google`
   for every hostname a gym is served on: `GYM_HOSTNAME` for a single-gym install,
   each gym's hostname in multi-gym mode. The wizard's Google page and
   **Settings → Google sign-in** show the exact address for the gym you are signed in to.
3. Enter the client ID and secret in the wizard or in **Settings → Google sign-in**.
   Or put them in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then run
   `sudo docker compose up -d`.

Google signs in existing logins only, the same staff and member logins that email
links and passwords use: nobody gets a new login through Google. The first Google
sign-in joins the login whose email is the Google account's address, and only when
both addresses are verified: Google's, and the login's own (an email link verifies
it). A login set up with a password on an install without email has an unverified
address, so it can't use Google. The app stores no Google tokens. To turn Google
sign-in off, use **Turn off Google sign-in** in Settings for a client entered in the
app (refused while Google is your only way to sign in), or remove both variables and
restart; people then sign in another way.

## Tenancy and demo

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `TENANCY` | `single` | `single` serves the one gym created in setup. `multi` serves several gyms, each created with `gym-app gyms create` and found by hostname; it requires S3 uploads, `SMTP_HOST` and `AUTH_PASSWORD_LOGIN=off`, and has no in-process backups. |
| `GYM_INTEGRATIONS` | `operator` | Multi-gym only; a single-gym install ignores it. `operator` makes the email and payments parts of **Settings → Email, payments and backups** read-only for gym owners: gyms send through the install's `SMTP_*`, and the API refuses changes with a 403. `gym` lets owners set their own SMTP server and Stripe key, which is how a gym connects Stripe, since there is no install-wide Stripe key. Settings already stored stay in use under `operator`. |
| `DEMO_MODE` | `false` | `true` turns on sandbox gyms for visitors (multi-gym only). See `apps/server/src/demo/README.md`. |
| `DEMO_DOMAIN` | none | Demo mode: the domain sandboxes are created under. |
| `DEMO_MAX_SANDBOXES` | `50` | Demo mode: the most sandboxes that may exist at once. |
| `DEMO_STRIPE_TEST_KEY` | unset | Demo mode: a Stripe test-mode key shared by sandboxes. Live keys are refused. |
| `DEMO_STRIPE_WEBHOOK_SECRET` | unset | Demo mode: the signing secret (`whsec_…`) of that account's webhook endpoint. Required with `DEMO_STRIPE_TEST_KEY`. |

## Set by the image

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` in the image | `production` turns on `Strict-Transport-Security`, production sign-in behavior, and the server's own multi-gym check that it holds no maintenance credentials. The image's entrypoint makes that check in multi-gym mode whatever `NODE_ENV` is. |
| `APP_VERSION` | the embedded Git version | The version shown on the health page, in OpenAPI and by `/healthz`; build metadata marks a development build. |
| `APP_REVISION` | the embedded Git commit | Full commit returned by `/healthz`; the UI displays its short form. |
| `SCHEMA_ROLLBACK_FLOOR` | unset on a new install | Oldest compatible version, supplied by the updater's checked `schema-compatibility.yaml`. Keep that file with its database; see [rollback](updating.md#roll-back-a-release). |
| `SCHEMA_RELEASE` | unset on a new install | Release that raised the recorded rollback floor, shown when older code is refused. |
| `SCHEMA_SNAPSHOT` | unset on a new install | Pre-upgrade snapshot from before the recorded compatibility boundary, shown with restore instructions. |
| `NODE_OPTIONS` | `--max-old-space-size=256` | Node's options; the default caps the JavaScript heap at 256 MiB. |
| `PLAINGYM_NODE_FLAGS` | `--max-semi-space-size=4` | Set by the image, not in `.env`: V8 flags its start scripts pass to `node`, whatever `NODE_OPTIONS` says (see below). |

The image also sets two defaults read internally by **glibc**, for every app process including backups:
`MALLOC_MMAP_THRESHOLD_=131072` keeps large freed buffers from being retained in the heap after glibc
would otherwise raise its mmap threshold, and `MALLOC_ARENA_MAX=2` limits allocation arenas.
The image's start scripts pass `PLAINGYM_NODE_FLAGS` to `node` (the server, `gym-app`, and the startup and
migration steps), so installs with an older `compose.yaml` get it too. A smaller young generation is collected sooner, which keeps the waiver PDF renderer's
peak memory well under its 300 MiB test bound. Container and V8 old-space limits are unchanged. See the [memory check](../deploy/test/memory/README.md)
for the measured effect.

## Compose and Caddy

These are read by `deploy/compose.yaml`, not by the app.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `APP_IMAGE` | none | The exact image to run: a version tag or a `sha256` digest, never `latest`. `update.sh` changes it. |
| `COMPOSE_FILE` | `compose.yaml` | The updater appends `schema-compatibility.yaml` so ordinary Compose commands preserve the startup rollback guard. |
| `ACME_EMAIL` | none | The email Caddy gives the certificate authority. |
| `COMPOSE_PROJECT_NAME` | `plaingym` | The Compose project name (container and volume prefix). |
| `HTTP_PORT` | `80` | The host port Caddy publishes for HTTP (certificate challenges and redirects). |
| `HTTPS_PORT` | `443` | The host port Caddy publishes for HTTPS. |
| `APP_MEMORY_LIMIT` | `512m` | The app container's memory limit. |
| `POSTGRES_MEMORY_LIMIT` | `384m` | The PostgreSQL container's memory limit. |
| `CADDY_MEMORY_LIMIT` | `128m` | The Caddy container's memory limit. |
| `CADDY_ACCESS_LOG` | `discard` | `stderr` turns on Caddy's access log (`deploy/README.md`, "Access log"). |

## Automatic patch updates

`update.sh --patch`, which the installer's nightly timer runs, reads this from `.env`, and Compose passes the same
value to the app, so the "Update available" banner reads the releases the updater follows. Whether patch releases install on their own is the owner's switch in **Settings → Updates**, stored in
the database ([self-hosting.md](self-hosting.md#updates)).

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `RELEASE_REPOSITORY` | `plaingym/plaingym` | The GitHub repository whose releases the updater checks, as `owner/name`. Unset or empty means the default; a value that is not `owner/name` (a segment made only of dots is not valid either) raises a warning and the banner, saying patches can't install (the updater skips its night). A fork that publishes its own releases sets it and replaces `release-signing.pem` in the install directory with its own public key. |

## Development only

`.env.example` at the repository root sets these for `pnpm dev` and the
development Compose file: `COMPOSE_PROJECT_NAME`, `POSTGRES_PORT`,
`MAILPIT_SMTP_PORT` and `MAILPIT_HTTP_PORT`, and `VITE_HOST` for the local HTTPS
proxy on native Linux. Tests read `TEST_DATABASE_URL`,
`TEST_MAINTENANCE_DATABASE_URL`, `TEST_DATABASE_ADMIN_URL` and `TEST_LOGS` (root
`README.md`, "Checks and boundaries").
