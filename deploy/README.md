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
`/usr/local/share/system-packages.tsv`. Debian/PGDG package versions are exact
constraints; rebuilding old images requires those versions to remain available
in the upstream repositories or an archive.

The image workflow builds and tests on native amd64 and arm64 runners, exports
both tested images, and assembles their manifest in an ephemeral loopback
registry. The images and manifest are short-lived workflow artifacts. It does
not publish releases, external registry images, or Git tags.

## Install

Extract the reviewed deployment bundle onto the server. From that directory:

```sh
sudo sh install.sh --hostname gym.example.org --email owner@example.org \
  --image ghcr.io/plaingym/app:vX.Y.Z
```

Substitute an existing image tag or digest. No released image is assumed to
exist. For a maintainer build, export it using `docker save`, transfer the
archive privately, run `sudo docker load -i image.tar`, and pass
`--image plaingym:v0.0.0-local --local-image`. The image is never built on the
server. Use the matching CPU architecture.

The installer configures Docker, firewall rules, unattended OS security
updates, and swap. It generates six independent secrets, then starts the
stack in `/opt/plaingym`. Its `.env` is mode 0600 in a mode-0700 directory;
public bootstrap/configuration files are readable by their containers.
Re-running against an existing `.env` stops without replacing secrets.
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
it as provider user-data. `cloud-init-local.yaml` accepts a directly transferred
bundle and image for unpublished builds; its transfer instructions are inline.

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
