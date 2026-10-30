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
`POSTGRES_MEMORY_LIMIT`, `CADDY_MEMORY_LIMIT`, or `NODE_OPTIONS` in `.env`.

## Build and check

Run from the repository root with Docker running:

```sh
docker build -f deploy/Dockerfile \
  --build-arg SOURCE_URL=https://github.com/plaingym/plaingym/tree/REVIEWED_COMMIT \
  --build-arg REVISION=REVIEWED_COMMIT \
  --build-arg VERSION=0.0.0-local \
  -t plaingym:v0.0.0-local .
SOURCE_URL=https://github.com/plaingym/plaingym/tree/REVIEWED_COMMIT \
  VERSION=0.0.0-local node deploy/test/smoke.mjs plaingym:v0.0.0-local
```

Use the release tag's source URL for a release build, or your fork's exact
source URL for modifications. Docker's file-specific ignore list excludes
credentials, Git history, dependencies, and local build outputs.
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
pnpm store.

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

Extract the reviewed deployment bundle onto the server. From that directory:

```sh
sudo sh install.sh --hostname gym.example.org --email owner@example.org \
  --image ghcr.io/plaingym/app:vX.Y.Z
```

Substitute an existing image tag or digest. No released image is assumed to
exist. The image is never built on the server; use the matching CPU
architecture.

Before changing anything, the installer checks its inputs: the hostname must
resolve (A, and AAAA if present) only to this server, so use DNS-only records,
not a proxy. If a check fails, nothing on the server was changed.

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

`bootstrap.sh` verifies the SHA256 before extracting anything, refuses a bundle
for another CPU architecture, and runs `install.sh --image-archive`. A bundle
already on the server can be passed with `--bundle-file PATH` instead.

The installer configures Docker, firewall rules, unattended OS security
updates, and swap. It generates six independent secrets, then starts the
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
deferred with **Set up later**; the health page reports them as not configured.

`cloud-init.yaml` automates the same installer from a reviewed public commit.
Replace its commit, hostname, email, and image placeholders before supplying
it as provider user-data. `cloud-init-local.yaml` runs the one bundle command
above as user-data for unpublished builds.

For manual Compose use, copy `.env.example` to `.env`, set real independent
URL-safe values and an image pin, protect it with `chmod 600 .env`, and run
`docker compose up -d --wait` from this directory. Bootstrap asserts safe
runtime/maintenance roles on each app start; a healthy TCP database probe alone
does not establish correct role initialization.

## Updates and recovery

Generate an age key pair on your own computer (`age-keygen -o backup.key`).
Keep the private key off the server and put only the public recipient in
`BACKUP_RECIPIENT` in the server's `.env`. Then run:

```sh
cd /opt/plaingym
sudo ./update.sh ghcr.io/plaingym/app:vX.Y.Z
```

The current updater supports the empty scaffold schema and empty uploads.
It checks both and the age recipient before changing anything, locks out
concurrent updates, pulls the target image while the app still runs, then stops
the app and creates an encrypted local archive in `snapshots/`. The archive
contains a custom-format database dump, uploads tar, recovery environment, and
previous image pin. Nothing is written between capture and the start of the
target image. It then starts the target image, verifies the no-migration schema and health endpoint,
and changes the persisted image pin only on success. A failed image start or
check restarts the exact previous local image. Keep those images available.

These are local deployment recovery archives, not application backup-service
snapshots. They include database credentials and encryption keys. Inspect one
on a trusted machine with `age -d -i backup.key SNAPSHOT.tar.age > recovery.tar`.
Extract it privately; `recovery.env` is the original deployment configuration,
`database.dump` is readable by PostgreSQL 18's `pg_restore`, and
`uploads.tar` holds the uploads directory. Recovery is an operator procedure;
the current server has no restore command. Archives are retained until the
operator removes them. A lost age private key makes them unrecoverable.

An application schema or uploads cause the updater to stop and require the
coordinated application backup/migration commands. No SQL migration is invented
or silently skipped. Automatic patch selection/timers are not installed;
`--patch` returns an explicit error.

The host updater tests exercise real age encryption and decryption with a
Docker command fixture for orchestration failures. The separate image smoke
test uses actual PostgreSQL, app, and Caddy containers:

```sh
sudo sh deploy/test/update.sh
node deploy/test/smoke.mjs IMAGE
```
