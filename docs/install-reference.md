<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Install reference

The detail behind [Install PlainGym](install.md): reading the installer before you run it,
what the installer does and checks, the other two install routes, and adding the update
timer on a hand-made install. Every setting is in [configuration.md](configuration.md);
the installer's internals are in [`deploy/README.md`](../deploy/README.md#install).

Each release is a version, `vX.Y.Z`; where a page writes `vX.Y.Z`, put the version you
are installing. The app image is named by version tag (`ghcr.io/plaingym/app:vX.Y.Z`) or
digest; it covers amd64 and arm64. The server never builds it.

## What the one-command install checks

Each release publishes its own `bootstrap.sh`, holding that release's version and the
project's release signing public key (`deploy/release-signing.pem`). Before it installs
anything, it:

1. downloads the release's manifest (`release-manifest.txt`) and its signature, and
   checks the signature with that key;
2. downloads the deployment files (`plaingym-deploy-vX.Y.Z.tar.gz`, the release's
   `deploy/` folder) and checks them against the SHA-256 the signed manifest lists;
3. runs the archive's full manifest validator, and checks that the release has an
   image for this server's CPU and that the archive carries the same signing key;
4. runs the archive's `install.sh` with the image digest and release repository
   (so a fork's updates keep using that fork).

If any check fails it stops with "Nothing was changed", and it leaves no downloaded
files behind either way. The installer copies the archive's `release-signing.pem` into
`/opt/plaingym`, and the nightly updater checks every later release with it.

### Reading `bootstrap.sh` first

Trust starts with the HTTPS download of `bootstrap.sh` from `github.com`: whoever can
change that file can change what it checks. To read it before running it, download it
first (`curl -fsSLO https://github.com/plaingym/plaingym/releases/download/vX.Y.Z/bootstrap.sh`),
check that its `release_key=` line matches the body of `deploy/release-signing.pem` in the
repository, then run `sudo sh bootstrap.sh --hostname … --email …`.

### From the deployment files

If you already have a release's deployment files on the server (its
`plaingym-deploy-vX.Y.Z.tar.gz`, unpacked), run the installer from that `deploy/` folder,
with the same release's image:

```sh
sudo sh install.sh --hostname gym.example.org --email owner@example.org \
  --image ghcr.io/plaingym/app:vX.Y.Z
```

## What the installer does

In order, the installer:

1. checks the hostname's DNS ([below](#the-dns-check));
2. installs Docker, turns on the firewall (SSH, 80, 443), unattended OS security updates
   and, when no swap is active, 1 GiB of swap;
3. writes `/opt/plaingym/.env` (mode 0600) with six independent random secrets;
4. starts Caddy, the app and PostgreSQL, and waits for a valid certificate and
   `https://gym.example.org/healthz`;
5. installs and starts the nightly update timer (`plaingym-update.timer`), which
   installs patch releases automatically ([updating.md](updating.md));
6. prints `https://gym.example.org/setup#token=…`.

Running the same command again is safe: it keeps `.env`, starts anything that has
stopped and prints the link again. It refuses a different hostname, email or image;
change the image with `update.sh` ([update by hand](update-by-hand.md)).

Before it prints the link, the installer fetches a random value of this install's through
the hostname (`/.well-known/plaingym-origin`, served by Caddy). If what answers isn't this
server, it stops without printing the link, so the link's secret never goes to another
server.

## The DNS check

The installer checks the hostname before it changes anything. A hostname must resolve (A,
and AAAA if present) only to this server, or to Cloudflare's proxy.

* **The name doesn't resolve yet.** Check that its record points here. A recently added or
  changed record, including a cached "no such record" answer, can take until its TTL
  expires, which can be an hour or more. Retry afterwards.
* **A confirmed address mismatch** needs a DNS-only record pointing here (or Cloudflare's
  proxy, see [cloudflare.md](cloudflare.md)). If the server has no global IPv6 address,
  remove the AAAA record or configure working public IPv6.
* **"Could not query DNS".** When a hostname lookup fails, the installer also tries
  `api.ipify.org`. If neither query succeeds, check the server's DNS resolver and network
  connection.
* **"Could not confirm the address".** An address that isn't on this server's network
  interfaces (a server behind NAT) makes the installer look up its public address. If that
  lookup failed, or a filtering proxy or captive portal answered with something other than
  an address, check that `curl` is installed and outbound HTTPS works. A confirmed mismatch
  takes priority over an unconfirmed address.

Each refusal ends with "Nothing was changed."

## Route 2: cloud-init

Many providers accept a cloud-init file as "user-data" when you create the server.
[`deploy/cloud-init.yaml`](../deploy/cloud-init.yaml) downloads and runs the same release
bootstrap as the one command, including the signed manifest and archive checks.

1. Copy the file and edit the placeholders in its script:
   * `version=VERSION`: the release tag to install (`vX.Y.Z`);
   * `--hostname HOSTNAME` and `--email EMAIL`.

   For a fork, change the download URL's repository too; its release bootstrap carries the
   fork's signing key and updater repository.
2. Create an Ubuntu 24.04 or 26.04 server with the file as user-data, and point the
   hostname's DNS at the server's address.
3. The script runs once at first boot. Create the DNS record **before** boot, or the
   installer stops at its DNS check; if that happened, fix the record, then log in over
   SSH and run `sudo sh /root/install-plaingym.sh` again. If you used
   [`deploy/cloud-init-local.yaml`](../deploy/cloud-init-local.yaml) to test an unpublished
   bundle, its retry command is `sudo sh /root/install-plaingym-local.sh`.
4. Read the setup link from the installer's output, or print it on the server:

   ```sh
   cd /opt/plaingym
   sudo docker compose exec -T app gym-app setup-link
   ```

## Route 3: Docker Compose by hand

Use this on a server you already manage (Docker and Compose installed, ports 80 and 443
free). The installer's host changes (firewall, swap, OS updates and the nightly update
timer) are then yours to make.

1. Copy `compose.yaml`, `Caddyfile`, `postgres/01-roles.sh`, `update.sh`, `rotate-key.sh`,
   `restore.sh` and `lib.sh` from a release's `deploy/` folder into `/opt/plaingym`,
   keeping the `postgres/` folder. `update.sh` (which needs `lib.sh` beside it) is how you
   [update](update-by-hand.md), `rotate-key.sh` (also with `lib.sh`) replaces the
   encryption key ([self-hosting.md](self-hosting.md#rotating-the-encryption-key)), and
   `restore.sh` runs a [command-line restore](restoring.md#restore-from-the-command-line).
2. Copy `deploy/.env.example` to `.env` there, and replace every placeholder:
   * `APP_IMAGE`: the version tag or digest;
   * `GYM_HOSTNAME` and `ACME_EMAIL`;
   * `POSTGRES_PASSWORD`, `APP_PASSWORD`, `MAINTENANCE_PASSWORD`, `AUTH_SECRET` and
     `SETUP_TOKEN`: independent random values (`openssl rand -hex 32` each);
   * `APP_ENCRYPTION_KEY`: 64 hex characters (`openssl rand -hex 32`).
3. Protect it with `chmod 600 .env`, then start the stack:

   ```sh
   docker compose up -d --wait
   docker compose exec -T app gym-app setup-link
   ```

Keep a copy of `.env` somewhere safe: it holds `APP_ENCRYPTION_KEY`. Memory limits,
`AUTH_PASSWORD_LOGIN`, the access log and the optional install-wide `SMTP_*` settings are
described in [`deploy/README.md`](../deploy/README.md) and [configuration.md](configuration.md).

### Adding the update timer

This route installs no update timer, so patch releases don't install themselves (the
Health page's **Automatic updates** tile says no check has run). To add it, copy
`release-signing.pem` from `deploy/` into `/opt/plaingym` too when your copy of the
deployment files has one, then, from `deploy/`, install the two units with the install
directory filled in:

```sh
for unit in plaingym-update.service plaingym-update.timer; do
  sed 's#@ROOT@#/opt/plaingym#g' "systemd/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now plaingym-update.timer
```

## Behind a proxy or a fork

* Cloudflare's proxy has its own page: [cloudflare.md](cloudflare.md).
* A fork sets `RELEASE_REPOSITORY=owner/repository` in `.env` (or passes
  `install.sh --repository OWNER/REPO`, which a release bootstrap does for you) to the
  GitHub repository publishing its signed releases, and installs that repository's release
  signing public key.
