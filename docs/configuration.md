<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Configuration

PlainGym reads its configuration from environment variables. A self-hosted
install keeps its values in `/opt/plaingym/.env` (mode 0600), which the installer
writes. Gym settings are not environment variables: the owner sets email, Stripe
and backups in the setup wizard (and changes them later in the admin's
**Settings → Email, payments and backups**), and the gym's details, booking and
billing rules in the admin's **Settings**. They are stored in the database, encrypted where
secret.

`deploy/compose.yaml` has no `env_file`: the app container gets only the variables
its `environment:` block names. From `.env` it passes `GYM_HOSTNAME`, the `SMTP_*`
settings, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, `SOURCE_URL`, `APP_ENCRYPTION_KEY`, `AUTH_SECRET`, `SETUP_TOKEN`,
`POSTGRES_DB`, `APP_PASSWORD`, `MAINTENANCE_PASSWORD`, `NODE_OPTIONS`,
`AUTH_PASSWORD_LOGIN`, `RATE_LIMIT_PER_MINUTE`, `UPDATE_CHECK` and `DATABASE_POOL_MAX` (the last
four with their defaults when unset or empty); it fixes
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
message when a value is missing or invalid.

A test (`apps/server/src/core/configuration.docs.test.ts`) fails when the server
or the image's start-up scripts read a variable, or `deploy/compose.yaml` uses
one, that this page doesn't list.

## Required

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `APP_ENCRYPTION_KEY` | none | 32 random bytes as 64 hex characters (`openssl rand -hex 32`). Encrypts the secrets stored in the database. Backups carry it, encrypted to the owner's backup key, so a restore can recover it; without it or a backup, stored Stripe, SMTP and backup credentials are lost. Never change it on a running install. |
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
| `UPLOADS_S3_ENDPOINT` | AWS | The bucket's endpoint, for providers other than AWS (Cloudflare R2, MinIO, Backblaze B2 and others). |
| `UPLOADS_S3_REGION` | `auto` | The bucket's region. `auto` suits Cloudflare R2 and most S3-compatible providers; AWS S3 needs the bucket's region set here. |
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
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests per minute per gym and client address before the app answers 429, from 1 to 100,000. Sign-in, kiosk PINs and CSP reports keep their own limits. |
| `UPDATE_CHECK` | `on` | `off` stops the app asking GitHub once a day for the newest release (the "Update available" banner and the Health page's update tile), for an install that must not call out; so does any value other than `on`, `true` or `1`. It sends no token and no data about the install. A multi-gym install never checks. |
| `GOOGLE_CLIENT_ID` | unset | The client ID of a Google OAuth client. With `GOOGLE_CLIENT_SECRET`, turns on **Sign in with Google** for staff and members (see below). Set both or neither; an empty value counts as unset. Ignored in demo mode. |
| `GOOGLE_CLIENT_SECRET` | unset | That client's secret. |

### Google sign-in

Google sign-in is optional and comes only from these two variables, in single- and
multi-gym mode alike: a gym owner never enters OAuth credentials. Without them the
sign-in page shows no Google button and **Settings** has no Google section.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an OAuth client of type **Web application** (set up the OAuth consent
   screen first if asked).
2. Under **Authorized redirect URIs**, add `https://<gym hostname>/api/auth/callback/google`
   for every hostname a gym is served on: `GYM_HOSTNAME` for a single-gym install,
   each gym's hostname in multi-gym mode. **Settings → Google sign-in** shows the
   exact address for the gym you are signed in to.
3. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, then run `sudo docker compose up -d`.

Google signs in existing logins only, the same staff and member logins that email
links and passwords use: nobody gets a new login through Google. The first Google
sign-in joins the login whose email is the Google account's address, and only when
both addresses are verified: Google's, and the login's own (an email link verifies
it). A login set up with a password on an install without email has an unverified
address, so it can't use Google. The app stores no Google tokens. To turn Google
sign-in off, remove both variables and restart; people then sign in another way.

## Tenancy and demo

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `TENANCY` | `single` | `single` serves the one gym created in setup. `multi` serves several gyms, each created with `gym-app gyms create` and found by hostname; it requires S3 uploads, `SMTP_HOST` and `AUTH_PASSWORD_LOGIN=off`, and has no in-process backups. |
| `DEMO_MODE` | `false` | `true` turns on sandbox gyms for visitors (multi-gym only). See `apps/server/src/demo/README.md`. |
| `DEMO_DOMAIN` | none | Demo mode: the domain sandboxes are created under. |
| `DEMO_MAX_SANDBOXES` | `50` | Demo mode: the most sandboxes that may exist at once. |
| `DEMO_STRIPE_TEST_KEY` | unset | Demo mode: a Stripe test-mode key shared by sandboxes. Live keys are refused. |
| `DEMO_STRIPE_WEBHOOK_SECRET` | unset | Demo mode: the signing secret (`whsec_…`) of that account's webhook endpoint. Required with `DEMO_STRIPE_TEST_KEY`. |

## Set by the image

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` in the image | `production` turns on `Strict-Transport-Security`, production sign-in behavior, and the server's own multi-gym check that it holds no maintenance credentials. The image's entrypoint makes that check in multi-gym mode whatever `NODE_ENV` is. |
| `APP_VERSION` | the image's version | The release shown on the health page. |
| `NODE_OPTIONS` | `--max-old-space-size=256` | Node's options; the default caps the JavaScript heap at 256 MiB. |

## Compose and Caddy

These are read by `deploy/compose.yaml`, not by the app.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `APP_IMAGE` | none | The exact image to run: a version tag or a `sha256` digest, never `latest`. `update.sh` changes it. |
| `ACME_EMAIL` | none | The email Caddy gives the certificate authority. |
| `COMPOSE_PROJECT_NAME` | `plaingym` | The Compose project name (container and volume prefix). |
| `HTTP_PORT` | `80` | The host port Caddy publishes for HTTP (certificate challenges and redirects). |
| `HTTPS_PORT` | `443` | The host port Caddy publishes for HTTPS. |
| `APP_MEMORY_LIMIT` | `512m` | The app container's memory limit. |
| `POSTGRES_MEMORY_LIMIT` | `384m` | The PostgreSQL container's memory limit. |
| `CADDY_MEMORY_LIMIT` | `128m` | The Caddy container's memory limit. |
| `CADDY_ACCESS_LOG` | `discard` | `stderr` turns on Caddy's access log (`deploy/README.md`, "Access log"). |

## Automatic patch updates

`update.sh --patch`, which the installer's nightly timer runs, reads this from `.env`; neither Compose nor the
app does. Whether patch releases install on their own is the owner's switch in **Settings → Updates**, stored in
the database ([self-hosting.md](self-hosting.md#updates)).

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `RELEASE_REPOSITORY` | `plaingym/plaingym` | The GitHub repository whose releases the updater checks, as `owner/name`. A fork that publishes its own releases sets it and replaces `release-signing.pem` in the install directory with its own public key. |

## Development only

`.env.example` at the repository root sets these for `pnpm dev` and the
development Compose file: `COMPOSE_PROJECT_NAME`, `POSTGRES_PORT`,
`MAILPIT_SMTP_PORT` and `MAILPIT_HTTP_PORT`, and `VITE_HOST` for the local HTTPS
proxy on native Linux. Tests read `TEST_DATABASE_URL`,
`TEST_MAINTENANCE_DATABASE_URL`, `TEST_DATABASE_ADMIN_URL` and `TEST_LOGS` (root
`README.md`, "Checks and boundaries").
