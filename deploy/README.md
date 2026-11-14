<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Deploying PlainGym

This stack serves the application and setup wizard over HTTPS. The installer
prints a private first-boot setup link after the health check succeeds.

Use an amd64 or arm64 Ubuntu 24.04/26.04 LTS server with a public DNS name.
Point its A record (and AAAA record, if present) at the server and allow inbound
TCP 80/443 and your SSH port. The installer keeps the configured SSH port open.
The server pulls a prebuilt image; build on a development machine or CI.

The default limits are 512 MiB for the app, 384 MiB for PostgreSQL, and 128 MiB
for Caddy. Node has a 256 MiB old-space limit. The installer adds 1 GiB of swap
when no swap is active. Use 2 GiB RAM for testing; whole-stack operation on a
1 GiB host has not been established. Override `APP_MEMORY_LIMIT`,
`POSTGRES_MEMORY_LIMIT`, `CADDY_MEMORY_LIMIT`, or `NODE_OPTIONS` in `.env`. The
same file sets `AUTH_PASSWORD_LOGIN`, `RATE_LIMIT_PER_MINUTE`, `UPDATE_CHECK`, `RELEASE_REPOSITORY` and
`DATABASE_POOL_MAX` (each uses the app's default when unset or empty; see
`docs/configuration.md` for what the shipped Compose file passes and what it does
not). `HardeningTests` in `demo/test_compose.py` renders the Compose file with and
without each to check this, with the caller's interpolated variables removed.

## Build and check

Run from the repository root with Docker running:

```sh
node scripts/release/build-image.mjs plaingym:reviewed
SOURCE_URL=https://github.com/plaingym/plaingym/tree/REVIEWED_COMMIT \
  node deploy/test/smoke.mjs plaingym:reviewed
```

Use the release tag's source URL for a release build, or your fork's exact
source URL for modifications. Docker's file-specific ignore list excludes
credentials, Git history, dependencies, and local build outputs.

To build an extracted source archive without Git history, use the pinned Node
and pnpm versions from `.nvmrc` and `package.json`, then run
`pnpm install --frozen-lockfile` in the extracted directory. Set `SOURCE_URL`
to the exact public source URL for the archive, then run `pnpm build`.
Without explicit build identity variables this embeds `<package version>+unknown` and commit
`unknown`; it is a development build, not a release. Supply both
`APP_BUILD_VERSION` and a full 40-character `APP_BUILD_REVISION` to embed a known
identity; supplying only one is an error. Keep `SOURCE_URL` set when running
the server too: the Source code link uses its `/source` redirect, which otherwise
defaults to the project repository.
Docker builds from an archive are also supported: set `SOURCE_URL` to the archive's
exact public source URL and run `node scripts/release/build-image.mjs plaingym:archive`
in the extracted directory. The helper supplies the package's `+unknown` version
and `unknown` revision explicitly, including in the image labels and runtime
environment. Direct `docker build` calls must pass both `VERSION` and `REVISION`;
missing arguments fail before dependency installation with a message naming the helper.
The image retains the supplied `SOURCE_URL` for its Source code link.
Matching archive identities do not trigger a browser reload; a
different version or commit does. Two archives with the same package version
and unknown commit cannot be distinguished by the navigation check.

The shared navigation check in admin, portal and kiosk runs at most once a
minute and waits at most one second for `/healthz`. A changed identity loads the
clicked destination, preserving its query and fragment. Link preloads and the
development server do not check; failed checks leave navigation alone. If stale
assets survive that load, the next check stops with an error instead of looping.

Runtime images contain the server bundle, adjacent fonts, SPA, Node notices,
dependency license texts, system copyright notices, and a package inventory at
`/usr/local/share/system-packages.tsv`. The runtime image runs `node` alone: the
base image's npm, npx, corepack and Yarn are removed.

The build (BuildKit, the default builder in current Docker) installs
dependencies from the lockfile and the workspace `package.json` files before it
copies the source, so a source-only rebuild reuses the installed `node_modules`
layer. A new workspace package needs its `package.json` added to that `COPY`
list in the Dockerfile. pnpm's store sits in a BuildKit cache mount
(`plaingym-pnpm-store`) rather than in an image layer, so a changed manifest or
lockfile only downloads the packages the store lacks. Each rebuild still leaves
the new build output and server bundle in Docker's build cache; `docker buildx du`
shows what it holds, and pruning it (`docker builder prune`) also clears the
pnpm store. The store itself only grows between lockfile changes and is never
pruned on its own. `docker buildx du --filter type=exec.cachemount` shows its
size, and `docker buildx prune --filter type=exec.cachemount` clears it alone,
so the next build downloads the packages again but keeps every layer.

CI builds on runners that start with an empty cache. Image checks and the weekly
image scan use the GitHub Actions cache backend (`type=gha`) for the Dockerfile's
layers, through Docker's `setup-buildx-action` and `build-push-action`: the
backend needs a BuildKit container builder and the cache service's token, which
only an action receives. The scope is one per architecture (`image-amd64`,
`image-arm64`); the scan shares `image-amd64`. A branch reads its own cache and
the default branch's, and Image checks builds on `main` only when it finds no
passing run for the same commit (it normally reuses the integration branch's
result), so the scan's weekly run on `main` is what seeds the amd64 cache for
new branches. The pnpm store mount is a cache mount, not a
layer, so the GitHub cache does not hold it; a changed lockfile downloads its
packages again, as on a fresh runner today. Image checks export only runtime-stage
layers (`mode=min`), retaining the pinned apt installation without exporting
intermediate source and dependency layers on every push. The weekly scan retains
all stages (`mode=max`), so a fallback to its cache can also reuse dependency
installation with unchanged manifests and lockfile. Intermediate build layers
are not retained by a branch's minimal cache. Entries share the repository's
10 GB Actions cache quota and are evicted least recently used first.
`gh cache list` shows them by scope.

The image workflow builds and tests on native amd64 and arm64 runners, exports
both tested images, and assembles their manifest in an ephemeral loopback
registry. The images and manifest are short-lived workflow artifacts. It does
not publish releases, external registry images, or Git tags.

## System packages

`deploy/apt-runtime-pins.txt` lists every Debian and PostgreSQL (PGDG) package
the runtime image installs or upgrades, each at an exact version, plus the
`snapshot.debian.org` timestamp they come from. `deploy/apt-runtime.sh install`
points apt at that snapshot of `bookworm`, `bookworm-updates` and
`bookworm-security`, and at the PGDG archive (`apt-archive.postgresql.org`,
suite `bookworm-pgdg-archive`), which keeps every version it has published. A
build therefore installs the pinned packages on any day and both architectures;
newer Debian or PGDG releases never break it, and none arrive unannounced.

Security updates are an explicit pin change. To take them, pick a newer
timestamp (UTC, `YYYYMMDDTHHMMSSZ`; the snapshot nearest before it is used) and
refresh the pins from a Linux or macOS shell with Docker:

```sh
sh deploy/apt-runtime.sh refresh 20261028T000000Z
git diff deploy/apt-runtime-pins.txt
```

The refresh starts the Node base image pinned in the Dockerfile, applies every
upgrade the snapshot offers, installs the runtime packages, and rewrites the
pins with every package that changed. PGDG has no snapshots: the refresh takes
the current stable `postgresql-client-18` release on the day it runs, checks that
the PGDG archive already serves every pinned version (it can lag a new release by
a day; refresh again later if not), and the pins then fix that version. Review the diff, since each changed line is an update the image takes, then
build both architectures and run `deploy/test/smoke.mjs` before committing. Bump
the Node base image digest in the same way, and refresh the pins after it so
packages the new base already provides drop out. A CVE fix in a Debian package
reaches the image only through such a refresh.

## Image scan

The **Image scan** workflow builds the runtime image every Monday, on demand, and
for pull requests that change the Dockerfile, the pins or the exceptions, and
scans it with Trivy (run from its image, pinned by digest). It lists every high
and critical advisory and fails when one has a fixed version, which a pin refresh
usually resolves. Advisories without a fix are listed for review but don't fail
the run. `deploy/trivy-ignore.yaml` holds the reviewed exceptions: each entry
names the advisory, why it doesn't apply or can't be fixed yet, and an
`expired_at` date after which the scan fails on it again. JavaScript dependencies
are checked separately by the **Dependency advisories** workflow (`pnpm audit`).

## Install

A release installs with its own `bootstrap.sh` (`docs/install.md`, Route 1):

```sh
curl -fsSL https://github.com/plaingym/plaingym/releases/download/vX.Y.Z/bootstrap.sh \
  | sudo sh -s -- --hostname gym.example.org --email owner@example.org
```

The release workflow fills in the copy it publishes with the release's version,
repository and the public key of `release-signing.pem` (**Releases**, below). It
downloads `release-manifest.txt` and its signature from that release and verifies
them with that key, as `update.sh` does; downloads `plaingym-deploy-vX.Y.Z.tar.gz`
and checks it against the manifest's `deploy_archive_sha256`; runs the archive's
`manifest_check`; checks that the manifest has an image for the server's
architecture and that the archive's `release-signing.pem` is the same key; and then
runs the archive's `install.sh` with `--image IMAGE:vX.Y.Z@DIGEST` from the manifest
and its stamped `--repository`. Apart from the bundle mode's
options (`--bundle-url` or `--bundle-file` with `--sha256`, below), it takes no
options of its own: every other argument goes to `install.sh`, except
`--image`, `--image-archive`, `--local-image` and `--repository`, which it refuses. Every refusal comes before `install.sh` runs, and
the downloads live in a temporary directory that is removed either way. The script
runs from a function called on its last line, so a download cut short runs nothing.
The copy in this folder has no key filled in and refuses release mode.

From an unpacked deployment archive (or any reviewed copy of this folder), the
installer also runs directly:

```sh
sudo sh install.sh --hostname gym.example.org --email owner@example.org \
  --image ghcr.io/plaingym/app:vX.Y.Z
```

Substitute an existing image tag or digest. The image is never built on the
server; use the matching CPU architecture.

Before changing anything, the installer checks its inputs: the hostname must
resolve (A, and AAAA if present) only to this server or to Cloudflare's proxy
(the addresses in `cloudflare-ranges.txt`). If a check fails, nothing on the server
was changed.

A hostname proxied by Cloudflare needs no option: the installer writes
`TRUST_CLOUDFLARE=true` to `.env`, so the app takes the visitor from
`CF-Connecting-IP` on requests from Cloudflare's ranges only. Since the DNS check
can't see past the proxy, the installer then fetches this install's random
`PLAINGYM_ORIGIN_NONCE` through the hostname (Caddy serves it at
`/.well-known/plaingym-origin`) and prints the private setup link only if it comes
back. That check runs once the stack is up, so when it fails the server is
installed (update timer included) but the link is withheld: fix the record, or
allow that path if a Cloudflare security setting challenges it, and re-run with the
same options. An install whose `compose.yaml` and Caddyfile predate proxy support
refuses a proxied re-run before changing anything; copy both from the current
deployment files first. If you proxy the record after installing, re-run the
installer so the app trusts Cloudflare's header. Set SSL/TLS to Full (strict) (Always
Use HTTPS can stay on; Cloudflare doesn't redirect `/.well-known/acme-challenge/`)
and add a Cloudflare rate-limiting rule, such as 50 requests in 10 seconds per IP
([../docs/install.md](../docs/install.md#behind-cloudflares-proxy-recommended)).
When the published ranges change, `node scripts/cloudflare-ranges.mjs` rewrites
the single canonical `cloudflare-ranges.txt`; the server build packages that same
file beside `server.mjs`, where the app reads it. Use deployment files and an image
from the same release so the installer checks the ranges that image trusts.

DNS refusals list every bad address. When `dig` or `resolvectl` is available, the
installer uses the hostname's DNS response code to distinguish missing records
from resolver failures. Otherwise it probes the dual-stack `api64.ipify.org` name;
that fallback cannot distinguish a failure confined to the gym's zone. Public
address responses must be canonical public unicast addresses (checked with
Ubuntu's Python standard library). A failed lookup identifies IPv4 or IPv6; without
global IPv6, check both the AAAA record and outbound IPv6, including IPv6 NAT.

`install.sh --repository OWNER/REPO` saves the updater repository in `.env` and
refuses a re-run with another repository. A release bootstrap supplies its stamped
repository automatically. The bootstrap caps manifests at 4096 bytes and runs the
authenticated archive's full `manifest_check` before the installer changes the host.

### One command from a bundle

For a maintainer build, create a checksummed bundle (deployment files plus the
image) on your own computer:

```powershell
deploy/test/prepare-bundle.ps1 -Image YOUR_TESTED_IMAGE
```

Upload `deploy/dist/plaingym-ARCH.tar` and `deploy/bootstrap.sh` to private
HTTPS storage, for example an R2 bucket with presigned links (the commands are in
`demo/README.md`, **Host the bundle in the existing R2 bucket**). Then paste the
command it prints on the server:

```sh
curl --fail --silent --show-error --location --proto '=https' 'BOOTSTRAP_URL'   | sudo sh -s -- --bundle-url 'BUNDLE_URL' --sha256 SHA256   -- --hostname gym.example.org --email owner@example.org
```

This is `bootstrap.sh`'s bundle mode, chosen by `--bundle-url` or `--bundle-file`;
the same script's release mode is the owner's install (**Install**, above), and the
bundle mode needs no filled-in key. It verifies the SHA256 before extracting
anything, refuses a bundle for another CPU architecture, and runs
`install.sh --image-archive`. A bundle already on the server can be passed with
`--bundle-file PATH` instead.

The installer configures Docker, firewall rules, unattended OS security
updates, swap, and the automatic patch update timer (**Automatic patch
updates**, below). It generates six independent secrets, then starts the
stack in `/opt/plaingym`. Its `.env` is mode 0600 in a mode-0700 directory;
public bootstrap/configuration files are readable by their containers.
Re-running the same command is safe: it keeps `.env` and its secrets, leaves
the installed files and the running image alone, starts anything that stopped,
and prints the setup link again (or the sign-in address once setup is done). A
re-run with a different hostname, email, or image stops without changes; change
the image with `update.sh`.
Containers have rotating logs. Only Caddy publishes ports. The app runs as
`node` with a read-only root filesystem, dropped capabilities, no Docker
access, a small temporary filesystem, and disk-backed state/staging storage.
PostgreSQL 18 stores its data at `/var/lib/postgresql`.

The installer exits successfully only after a public certificate validates
and `https://gym.example.org/healthz` responds. If this fails, inspect DNS,
firewall rules, and `sudo docker compose logs caddy` in the install directory.
Do not delete database volumes to retry an installation.

Open the private `/setup#token=…` link printed by the installer. `SETUP_TOKEN`
in `.env` proves that the person creating the first owner or restoring a backup
controls the server. Public certificate issuance alone never grants setup access.
The browser removes the token from the address bar and keeps it for this tab;
setup actions close after initialization. To reprint the link on the server:

```sh
cd /opt/plaingym
sudo docker compose exec -T app gym-app setup-link
```

For manual Compose installs, generate `SETUP_TOKEN` independently with
`openssl rand -hex 32` before starting. Existing installs must add it to `.env`
when updating their Compose file. Backups can be configured in the wizard or
deferred with **Set up later**; the health page reports them as not configured
until the owner adds them in **Settings → Email, payments and backups**.

`cloud-init.yaml` runs the versioned release bootstrap, including signed manifest
and archive validation. Replace its version, hostname and email placeholders before
supplying it as provider user-data. `cloud-init-local.yaml` runs the one bundle command
above as user-data for unpublished builds.

For manual Compose use, copy `.env.example` to `.env`, set real independent
URL-safe values and an image pin, protect it with `chmod 600 .env`, and run
`docker compose up -d --wait` from this directory. Bootstrap asserts safe
runtime/maintenance roles on each app start; a healthy TCP database probe alone
does not establish correct role initialization.

### Which process holds the maintenance role

The app connects as `app`, which row-level security confines to one gym at a
time. The `maintenance` role (`BYPASSRLS`) runs migrations, backups, restore and
key rotation.

* **Single-gym installs** (`TENANCY=single`, this directory's `compose.yaml`):
  the app container holds `MAINTENANCE_PASSWORD` and `MAINTENANCE_DATABASE_URL`.
  Its entrypoint checks the roles, resumes an interrupted restore and migrates
  before the server starts, and the server takes backups in-process. After the
  migrations, the same step rewrites any stored secret still in a `v1` envelope
  as `v2` with `APP_ENCRYPTION_KEY` (`docs/security-model.md`).
* **Multi-gym installs** (`TENANCY=multi`, such as the [demo](demo/README.md)):
  the app container never holds the role, so a compromised app process can't
  reach every gym. A one-shot `migrate` service from the same image runs
  `/app/deploy/database.sh prepare` (role check, then migrations) and exits;
  the app starts only after it succeeds (`service_completed_successfully`).
  In production (`NODE_ENV=production`, as in the image) the app refuses to
  start when either variable is set, naming the variable. Without the role,
  multi-gym installs have no in-process backups or restore: their app ignores
  `BACKUP_STAGING_DIR` (the Compose files leave it unset), so the setup
  wizard's restore answers that it isn't configured and no restore gate
  pauses requests, and the daily upload sweep runs without the backup lock.
  The `migrate` service holds `APP_ENCRYPTION_KEY` and runs the same `v1` to
  `v2` rewrite after migrations. `v1` values still read for compatibility
  (`docs/security-model.md`).

## Logs

The app writes one JSON object per line to its container's standard error
(`sudo docker compose logs app`): a `time`, a `level`, an `event` name and
identifiers such as the gym ID. Error lines carry the error's name, code and
stack frames, never its message, because messages can quote submitted values,
credentials, file paths or database URLs. Docker rotates the logs.

### Access log

Caddy's access log is **off by default**: a gym's visitors aren't tracked
unless the owner chooses it. To turn it on, add this line to `.env` and run
`sudo docker compose up -d`:

```sh
CADDY_ACCESS_LOG=stderr
```

Each request then adds one JSON line to `sudo docker compose logs caddy`, in
the same rotating container log: time, client address, method, host, path,
status, response size, duration and the request headers (such as the user
agent). It records no query string and no request body, Caddy masks the
`Cookie` and `Authorization` headers as `REDACTED`, the setup token header is
removed, and a signed link's token (`/l/<token>`) is cut from the path. Client addresses are personal data
in many places; keep the log only as long as you need it. Remove the line (or
set `CADDY_ACCESS_LOG=discard`) and run the same command to turn it off again.

## Updates and recovery

Updates need backups configured, in the setup wizard or in **Settings → Email,
payments and backups**: the updater takes a pre-upgrade backup through them. Then
run:

```sh
cd /opt/plaingym
sudo ./update.sh ghcr.io/plaingym/app:vX.Y.Z
```

The updater takes an explicit semver tag or `sha256` digest, locks out
concurrent updates, and ordinarily requires the app to be running. A requested
`--rollback` also accepts a stopped or restarting app, with the same floor check.
After a recorded update migrated across a floor and failed, a manual update to
that same release or a newer compatible signed release also accepts a stopped or
restarting app. It pulls the target image and compares it with the running one: the
same image, by any tag or digest, prints "Already on the requested image." and changes
nothing. It verifies a release image against its signed
manifest and digest, then stops any running app and runs
`node /app/maintenance.mjs snapshot pre-upgrade` in a one-off app container: a
coordinated, encrypted install snapshot to the gym's backup destination, ordinarily kept
under the backup retention's pre-upgrade rule. Forward-recovery retries use `snapshot manual`
and its hourly/daily/weekly retention tiers, so they cannot displace the original snapshot
from the two pre-upgrade slots
(`apps/server/src/areas/health/backups.protocol.md`). Nothing is written between
the snapshot and the start of the target image. Without configured backups the
snapshot exits with "Backups are not set up: set them up in Settings → Email,
payments and backups, then run the update again", and the updater says nothing was changed and restarts
the current image. Any other snapshot failure prints a generic line (its cause goes
to the log without its message), with the same outcome. It then starts the target image, which applies its migrations before
reporting healthy, runs the health check, and changes the persisted image pin
in `.env` only on success. Every release path pins the same form, `IMAGE:vX.Y.Z@DIGEST`: a
release update the signed manifest's name, tag and digest, and `--rollback` the name and
digest the previous image was pulled with, so a removed image can be pulled back (a
locally built image with no registry digest keeps its image ID). A manual update to an
image without a release version label has no signed manifest, so it pins the reference
as given. A failed image start or check restarts the exact
previous local image (by image ID) when the schema allows it, so keep those images available. If an update
migrated across a floor, retry its release or update to a newer compatible signed
release; the failure message names that option beside the snapshot to restore.
Forward recovery snapshots with the failed release's compatible image, running
its maintenance command directly so its entrypoint cannot migrate before the
backup. Its recovery record and schema guard keep the snapshot from before the first
failed migration, even if another attempt raises the floor. Failure and rollback-refusal
messages name that original restore point. Keep that image locally. Restore a
pre-upgrade snapshot like any other, from the setup wizard on a fresh install or
with `gym-app restore`.

`restore.sh SNAPSHOT_ID CONFIG_JSON KEY_FILE` takes host file paths, streams them
to the maintenance CLI, and removes its app-owned 0600 copies after the restore
(in a 0700 directory on the data volume). The installer copies the helper for new
installs, and each release's update refreshes it with the other host files.
See [the restore guide](../docs/restoring.md#restore-from-the-command-line).
Restore leaves billing and member emails off. Backups continue with retention
pruning held until an owner confirms in Settings or Health that the old server is gone.

Backups use the key pair created in the setup wizard; an old
`BACKUP_RECIPIENT` line in `.env` is ignored.

### Automatic patch updates

The installer writes `plaingym-update.service` and `plaingym-update.timer`
(`systemd/`, with the install directory filled in) to `/etc/systemd/system` and
enables the timer. It fires every hour at a random minute and runs
`update.sh --patch`, which acts once a night: on the first run between 02:00 and
05:00 in the gym's timezone (which the app reports; UTC until it has). Every run
asks the app for the timezone first, so a changed timezone counts from the new
zone's next night; while the app can't answer, the zone it last gave decides. The
other runs stop there. A change of zone just after a night's run doesn't start a
second run within six hours. `update.sh --patch --now` runs the check at any time.

The app never holds the Docker socket. The updater asks the app, through
`docker compose exec -T app gym-app auto-update check`, whether a restore is in
progress, whether automatic updates are on (the owner's switch in **Settings →
Updates**, on by default), whether backups are set up, and the gym's timezone;
until the setup wizard has created the gym, it stops there without a result. It
reports each night's result back through `gym-app auto-update record --notice deferred`, which
the **Automatic updates** tile on the Health page shows. Results the app can't
take yet (it is down or restoring) wait in `auto-update.result`, one line each in
order, and are sent first on the next run; a later result never replaces an
unsent one, and a result the app refuses as invalid is dropped with a line in the
journal. `auto-update.state` holds the timezone, the night of the last check (its
date, zone and time), and the failed attempts per release.

When SMTP is configured, `gym-app auto-update notice` sends each owner one notice for a rolled-back
or failed attempt, through the gym's SMTP settings (or the install fallback).
While the app is down no email can go out, so an update whose rollback also
failed is reported only once the app runs again. The host records both results, then replaces an unsent
failure notice with the recovery notice, which says when the site went down and when it came back.
Durable delivery reservations prevent a repeated report from resending an
accepted or uncertain email. A definite SMTP refusal leaves only the notice in `auto-update.notices`;
each run retries each notice once after recording the queued results, so later results and notices still
go through. `record` without deferral, and `notice`, exit 3 for a definite non-send or a temporary
database, owner, or settings lookup failure; result storage errors exit 1 and invalid input exits 2.
Invalid local settings, unreadable SMTP secrets and rendering errors are logged without retrying the notice;
accepted or uncertain sends also exit 0. The health tile keeps stale errors visible and formats the last check in
the gym's timezone. A never-run install becomes stale 50 hours after its first
health read; transient skips raise the update banner after two consecutive
attempts. An invalid `RELEASE_REPOSITORY` raises a warning that patches cannot
install; use `owner/name`, with neither segment consisting only of dots.

If `release-signing.pem` is missing, re-run `install.sh` from the current
deployment files with `--image` set to the running image, or copy
`release-signing.pem` into the install directory. The installer refuses a
different image on an existing installation.

Each night, in order, the updater:

1. skips when the switch is off, a restore is in progress, backups aren't set up,
   there is no `release-signing.pem` in the install directory, or the running
   image's `org.opencontainers.image.version` label isn't a release version;
2. reads the tag names of the repository's GitHub releases (`RELEASE_REPOSITORY`,
   default `plaingym/plaingym`) and picks the newest `vX.Y.Z` with the running
   X.Y and a higher Z; none means up to date, and a release the owner rolled back
   from, or an older patch than that, is skipped and reported. So is a release
   whose automatic attempts failed twice (rolled back, failed, or interrupted):
   it waits for a newer patch, and `--now` tries it again;
3. downloads that release's `release-manifest.txt` and its signature, checks the
   signature with `release-signing.pem` and the manifest's fields (**Releases**,
   below);
4. pulls `IMAGE:vX.Y.Z@DIGEST` from the manifest while the app runs, and checks
   that the pulled image has that digest and version label, and that its
   migrations (`/app/migrations`) are byte for byte those of the running image;
5. writes `.auto-update.inflight` (the versions and the time the app stops), stops the app, takes the pre-upgrade snapshot
   (a failure, or a stop during it, restarts the running image and skips),
   starts the new image, runs the health check, waits a minute, and checks again
   that the same container is healthy and never restarted;
6. pins the new image in `.env`, or on any failure starts the previous image by
   image ID and reports the rollback, counting the failed attempt;
7. after success, keeps the current image and the two before it on the rollback
   stack. Older stack entries have their images removed, the installer's too
   once it falls off, and then get a `trimmed` row in `version-history.tsv`, so
   `--rollback` no longer offers them; so are images in `auto-update-images.tsv`
   (each pulled image listed once) that are no longer on the stack, such as a
   release that was rolled back. Removal is by image ID and never forced: Docker
   keeps an image a container uses or that other names refer to, and an entry
   whose image stays (or whose removal times out) stays on the stack until a later
   update removes it. No global image prune runs, and images the updater didn't
   record are untouched.

The journal line for each result names what happened: "updated from v1.2.3 to
v1.2.4", "up to date (v1.2.4; no newer patch)", "failed, rollback_failed (from
v1.2.3 to v1.2.4)", or the result and reason with the running and newest versions
for a skip or a rollback.

A run that is stopped (the unit's 90-minute limit, a shutdown) restarts the
previous image before it exits. One killed outright leaves `.auto-update.inflight`,
and the next run starts the pinned image first and reports the interruption. A
rollback that fails keeps the marker too, marked `rollback_failed`, so each hourly
run tries to start the pinned image again until it runs. The failure is reported
once; once the pinned image runs, the recovery is reported with the time the app
stopped. Its log is in the journal: `journalctl -u plaingym-update`.

### Rotating the encryption key

`rotate-key.sh` replaces `APP_ENCRYPTION_KEY` and re-encrypts every stored
secret with the new key ([docs/self-hosting.md](../docs/self-hosting.md#rotating-the-encryption-key)
says when):

```sh
cd /opt/plaingym
sudo ./rotate-key.sh
```

It takes the updater's lock, so it never runs beside `update.sh`; a new rotation
requires the app to be running. It then:

1. generates a new key and writes the current and new keys to
   `.rotate-key.inflight` (mode 0600), before anything is encrypted with the new
   one;
2. waits up to 30 seconds for `pg_isready` in the `postgres` service, and
   otherwise stops with nothing changed: the one-off below skips the
   entrypoint's database wait, and a database still starting would otherwise
   count as an uncertain failure;
3. stops the app and runs `node /app/maintenance.mjs rotate-key` in a one-off
   app container, with the current key from `.env` and the new one in the
   container's environment (`NEW_APP_ENCRYPTION_KEY`, never on a command line).
   It bypasses the image entrypoint, whose app-role check cannot connect under
   a fence retained by an interrupted rotation. This image already ran on the
   install; the rotation checks the restore gate itself without startup migrations.
   As the `maintenance` role and under the backup lock, the command refuses while
   a restore is unfinished. It revokes database CONNECT from `app` and `PUBLIC`,
   and refuses if `app` can still connect (a grant from another role, or through
   a role `app` is a member of). It waits up to 30 seconds for existing app
   sessions to close, and refuses with their remaining count if any persist. It
   never terminates sessions. It checks that every value in the encrypted-field
   registry opens with one of the two keys (if one doesn't, it lists where, by
   secret class and gym or sign-in account ID, changes nothing, and says whether
   any value already opens with the new key), then re-encrypts them as `v2`
   envelopes, a page of sign-in accounts and then one gym per short transaction.
   Pending backup credentials in settings are included (ones neither key opens
   are left as they are; confirming them asks for a new backup key). Before
   reporting success it verifies every value opens as `v2` with the new key and
   checks for app sessions again, still under the backup lock; a failed check
   requires a rerun with the same keys;
4. writes the new key into `.env`, restores CONNECT to `app` with
   `node /app/maintenance.mjs restore-connect` in another one-off app container
   (`PUBLIC` stays revoked), recreates the app from it, runs the health check,
   and removes `.rotate-key.inflight`.

A definite preflight refusal (maintenance exit code 3) restores CONNECT and
restarts the app with the current key if no earlier attempt may have committed
pages. Repeated clean refusals restart it each time, allowing settings to be fixed
in the admin. Before each attempt the marker durably records that pages may
commit; only a definite refusal with no earlier uncertainty clears that state.
Exit code 4 clears it too, after any earlier attempt: some value opens with
neither key and none opens with the new key yet, so no attempt committed a page,
and the app restarts with the current key so that setting can be fixed in the
admin. Older markers without this state are treated as possibly committed.
A partial rewrite (maintenance exit code 2, which a refusal also returns when
some values already open with the new key), any other uncertain failure (including
exit 1), an exit-3 refusal after either, or a run that can't write `.env` after
step 3 succeeded leaves the app stopped, since stored secrets may already open
only with the new key. A failed CONNECT grant also leaves it stopped. In each case
`.rotate-key.inflight` stays, and running `rotate-key.sh` again finishes the same
rotation: values that already open with the new key are done. Keep the file
until a run finishes, because it holds the only copy of the new key until then.
If the app doesn't start after step 4, `.env` already holds the new key; the
next run restores CONNECT again before starting the app. This also recovers a
crash between switching `.env` and granting CONNECT.

The app also derives the signatures of local download links and the cookies of
a join or Checkout return in progress from `APP_ENCRYPTION_KEY`, so those stop
working when it restarts with the new key; starting them again works. Signed
links (`/l/*`), sessions, PINs and check-in codes don't depend on it.

### Tests

The host updater test drives `update.sh` with a Docker command fixture and
checks the order (pull, stop, snapshot, start) and that a failure at each stage
(pull, snapshot, startup, health) keeps the previous image pinned and, once the
app has stopped, restarts it, and that a repeated request for the running image,
by its pin or its digest, changes nothing. The patch update test adds curl and clock fixtures
and real Ed25519 signatures: patch selection, a changed manifest, another key's
signature, a wrong digest or version label, a patch that changes migrations, the
switch off, no backups, a failed snapshot, rollback after a failed start, health
check or second check, a failed rollback with retries while the app is still down
and once it runs (the failure and one recovery recorded, in order), the nightly
window and a change of timezone, a release held after two failures, five updates
that leave only the kept images, results kept in order until the app can record
them, and an interrupted run. The floor test adds a fixture that
refuses the previous image under a guard above it, as the app does: a failed update
across a floor before and after migrating, an earlier guard put back, a skipped
minor, a killed run, unchanged attempts within the floor, and same-release or newer-release
recovery with the app stopped or restarting. Numbered snapshots check that repeated
recovery attempts retain and name the original restore point. The rollback test swaps real
local images, walks back two versions from stopped and restarting apps, and checks
that neither state permits a rollback below the floor; with images from a throwaway
local registry, it checks that `--rollback` pins `IMAGE:vX.Y.Z@DIGEST` and that the
app starts again after that image is removed. The key rotation test drives
`rotate-key.sh` with the same kind of fixture: the order (stop, rotate, `.env`,
CONNECT grant, start, health check), `.env` changing only after the rotation,
a restart with the current key after repeated clean preflight refusals, the exact
entrypoint bypass, durable marker state before each attempt, staying stopped
after a partial rewrite, generic or abnormal exit, refused partial retry,
failed CONNECT grant or `.env` write, an exit-4 refusal that restarts the app after
an uncertain or older marker, waiting for a database that is still starting and
changing nothing when it never answers,
finishing with the same new key and restoring CONNECT on the next run,
the refusals, and that no key reaches a command line or the output. The separate
image smoke test uses actual PostgreSQL, app, and Caddy containers:

```sh
sudo sh deploy/test/update.sh
sudo sh deploy/test/patch.sh
sudo sh deploy/test/floor.sh
sudo sh deploy/test/rollback.sh
sudo sh deploy/test/rotate-key.sh
node deploy/test/smoke.mjs IMAGE
```

## Releases

Use `pnpm release` (or `pnpm release 1.0.0` for the first public release) to prepare
the version bump, reviewed changelog section, and signed annotated tag. It checks
the branch, origin, CI and signing configuration first and never pushes. Patches
come from `release/X.Y`; their changelog section is also committed on `main` without
bumping `main`'s version. See [the versioning guide](../docs/versioning.md).

The installer starts `version-history.tsv`; the updater appends tab-separated UTC
time, version, immutable local image digest, outcome, rollback floor and snapshot
identifier. `starting` and `failed` attempts matter because migrations may already
have run; `abandoned` closes an attempt that left the database as it was, so its floor
doesn't count. `update.sh --rollback` checks all recorded floors before changing
anything, and reads the rows as a stack, so each run goes one version further back;
`trimmed` takes an older entry off that stack once a successful manual or patch update removed its image
(**Automatic patch updates**, above), so `--rollback` goes back at most two versions
from an update. `auto-update-images.tsv` also saves registry pins for manual updates and their previous
image, so `--rollback` can pull a removed image and verify its ID and version. Local builds without
registry digests still need their image on disk. Pruning removes inventory rows whose reference no longer
resolves to the recorded image, except for images still on the rollback stack, whose pins stay so a removed
image can be pulled again. A rollback request or manual update first settles an interrupted nightly
patch, then exits so the owner runs it again; a failed snapshot preserves an app that was already stopped.
`schema-compatibility.yaml` passes the checked floor, schema release and snapshot to
the app. Keep it with the database. It goes up before a new image starts. Before
each manual release update, `.schema-attempt` keeps the database's migration state
and `schema-compatibility.yaml.before` the guard it replaced, so a failed update or a
later run can take it down if nothing migrated. If a migrated attempt leaves the
pinned image below the floor, `.schema-recovery` keeps its identity until forward
recovery succeeds; a retry that changes nothing preserves that record and floor
(`docs/updating.md`). Releases carry the host files in the deployment archive, with
individual digests in the signed manifest. `update.sh` verifies the archive and
each file before stopping the app. After health checks, it replaces `update.sh`,
`lib.sh`, `rotate-key.sh`, `restore.sh`,
`release-signing.pem` (only the same trusted key), and both systemd unit templates;
it renders the installed units for this directory and reloads systemd. Each file
uses a temporary sibling and atomic rename, so the updater's running shell keeps
reading its original inode. `.env`, Compose, Caddy and PostgreSQL configuration
are preserved. A release changing those files names its manual configuration
steps in the upgrade notes; the updater never replaces local configuration.

`.host-update` journals the old files and rendered units before the first rename.
Until `.env` pins the target image, a failure or next invocation after an
interruption restores those files. After the pin it keeps the new files.
Both `update.sh` and `rotate-key.sh` recover under the update lock before loading `lib.sh`,
then re-execute their restored script. A failed systemd reload leaves restored files and the
journal in place for the next run. Failure during cleanup still rolls the image back and
writes the result and version history. A signal after the pin counts as success and removes
the schema attempt's recovery files.
`.host-history/<image-id>/` retains previous generations for `--rollback`; older
images without a saved generation retain their current host files on rollback.
After a successful update, history for images no longer on the host is removed beside
image cleanup, except for images whose saved pin `--rollback` can still pull. Recovery also sweeps abandoned prepare and retired journal directories.
Back up these directories with the install and keep them through recovery. The
signing key is never rolled back, and a different key in an archive is refused:
key rotation requires verifying and installing a new trusted public key explicitly
through the maintainer's release instructions, before updating. `rotate-key.sh`
rotates the app's encryption key, not this release trust key.

Manifests without `host_format` retain their image-only behavior.

The **Release** workflow (`.github/workflows/release.yml`) runs on a pushed
`vX.Y.Z` tag. It accepts only an annotated tag that GitHub verified as signed,
on `main` for `vX.Y.0` and on `release/X.Y` for a patch. `release/check-tag.sh`
requires the tag to match the root package version and refuses a patch whose `packages/db/src/migrations` (journal
included) differs from the latest earlier `vX.Y` tag: installs apply patches on
their own and roll one back by starting the previous image. CI also runs this
migration comparison on pushes to `release/**`, against the latest tag for that
branch's minor version, so a new migration fails before tagging. The workflow then
builds the image natively on amd64 and arm64 without the build cache, labelled
with the version and commit, runs the smoke test on each, and `release/publish.sh`
pushes `ghcr.io/OWNER/app:vX.Y.Z-amd64` and `-arm64`, then the multi-arch
`ghcr.io/OWNER/app:vX.Y.Z` over exactly those two. It signs the release manifest
with the `RELEASE_SIGNING_KEY` secret of the `release` environment, after
checking it against `release-signing.pem`, and creates the GitHub release with
four assets: `release-manifest.txt`, `release-manifest.txt.sig`,
`plaingym-deploy-vX.Y.Z.tar.gz` and `bootstrap.sh`. Before any push,
`release/deploy-assets.sh` builds the last two from the tagged commit: the archive
is its `deploy/` folder, read from Git with sorted names, the commit's time, root
ownership and plain modes, so rebuilding it from the tag gives the same bytes, and
`bootstrap.sh` is its `bootstrap.sh` with the version, repository and public key
filled in. The manifest lists the archive's SHA-256. The public key is
`deploy/release-signing.pem`, and the installer copies it into the install
directory. No release has been published yet.

`release/publish.sh` requires an explicit `--rollback-floor`; the workflow supplies
the value recorded by `pnpm release` in `release/rollback-floor.txt`. The historical
fallback for legacy format-1 manifests is retained only for reading old releases;
publication no longer uses it to guess a previous minor.

Every other run (a push that changes the workflow, `release/` or `bootstrap.sh`, or
a manual run) is a dry run with a Git build-metadata version, also on a commit that
already carries its tag (`version-cli.mjs --dry-run`): the images go to a registry
on the runner, and a throwaway key signs the manifest and goes into the archive. It
publishes nothing. `deploy/test/release.sh` tests both scripts, with a scratch Git
repository and dry releases of two small images to a local registry, and checks the
archive against the manifest; `deploy/test/install.sh` installs from a local
release with a release `bootstrap.sh`, and checks that it refuses a tampered
archive, a tampered manifest and another key:

```sh
sh deploy/test/release.sh
```

`release-manifest.txt` has one `key=value` line per field, no spaces, each key
once; `release-manifest.txt.sig` is the 64-byte Ed25519 signature of its exact
bytes (`openssl pkeyutl -verify -pubin -inkey release-signing.pem -rawin -in
release-manifest.txt -sigfile release-manifest.txt.sig`):

```text
format=plaingym-release-manifest/2
version=v1.2.3
rollback_floor=v1.1.0
image=ghcr.io/plaingym/app
digest=sha256:<64 hex digits>
digest.linux/amd64=sha256:<64 hex digits>
digest.linux/arm64=sha256:<64 hex digits>
deploy_archive=plaingym-deploy-v1.2.3.tar.gz
deploy_archive_sha256=sha256:<64 hex digits>
host_format=1
host.update.sh=sha256:<64 hex digits>
host.lib.sh=sha256:<64 hex digits>
host.rotate-key.sh=sha256:<64 hex digits>
host.restore.sh=sha256:<64 hex digits>
host.release-signing.pem=sha256:<64 hex digits>
host.systemd/plaingym-update.service=sha256:<64 hex digits>
host.systemd/plaingym-update.timer=sha256:<64 hex digits>
revision=<40 hex digits>
migrations=sha256:<64 hex digits>
released=2026-11-03T12:00:00Z
```

* `digest` is the multi-arch index; installs pull `IMAGE:VERSION@DIGEST`. The
  `digest.linux/*` lines are its per-architecture images.
* `deploy_archive` names the release's deployment files and `deploy_archive_sha256`
  is their SHA-256, checked by the release `bootstrap.sh` and the updater.
  `host_format=1` requires all seven `host.*` digests and the archive fields.
  The updater extracts only the fixed list above and checks every digest; it never
  executes or sources scripts from the downloaded archive during the current run.
* `revision` is the tagged commit.
* `migrations` is the digest of the migrations directory, computed as
  `update.sh` does (`find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum`
  in it).
  Patch updates compare the new image with both this signed value and the running
  image; an incorrect signed value is refused as `manifest_invalid`.
* `rollback_floor` is the oldest compatible release. A patch preserves its minor's
  floor; an incompatible major sets the floor to itself. The release workflow smoke-tests
  the previous minor on the new database before publishing a compatible `vX.Y.0`, and
  Image checks runs the same test on any commit that changes the migrations. Older code
  accepts a newer release's table only with the security shape every table has
  ([versioning guide](../docs/versioning.md#compatibility-from-10)).
* The current reader also accepts format 1 and manifests without host digests.
  The first tagged release uses format 2 including the `host.*` keys. From that first
  tag, adding a key that existing readers reject requires a new manifest format.
* A deployment archive that can't be downloaded is skipped as `manifest_unavailable`,
  like the manifest itself.
* GitHub release notes come from the matching `CHANGELOG.md` section.
