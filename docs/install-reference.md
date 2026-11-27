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
first (`curl -fsSLO https://github.com/plaingym/plaingym/releases/latest/download/bootstrap.sh`,
or `releases/download/vX.Y.Z/bootstrap.sh` for a particular release), check that its `release_key=` line matches the body of `deploy/release-signing.pem` in the
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
   and, when no swap is active, 1 GiB of swap. If the server is still installing its own
   updates, as a new server does in its first minutes, it waits up to 10 minutes for them;
3. writes `/opt/plaingym/.env` (mode 0600) with six independent random secrets;
4. starts Caddy, the app and PostgreSQL, and waits for a valid certificate and
   `https://gym.example.org/healthz`;
5. installs and starts the nightly update timer (`plaingym-update.timer`), which
   installs patch releases automatically ([updating.md](updating.md));
6. prints `https://gym.example.org/setup#token=…`.

Running the same command again is safe: it keeps `.env`, starts anything that has
stopped and prints the link again. It waits up to a minute for a running update or key
rotation, and otherwise stops with "An update is running. Try again in a few minutes.
Nothing was changed." It refuses a different hostname, email or image;
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
free). Configure the host firewall and automatic OS security updates yourself. This
route leaves swap as configured on the host, so set it up yourself if your 1 GB server
has none. You can add the [optional update timer](#adding-the-update-timer) after setup.

Run the following steps as root.

1. Start in the directory containing the release archive. The archive extracts to
   `deploy/`. Copy the files into `/opt/plaingym`, keeping `01-roles.sh` under
   `postgres/`.

   ```sh
   tar -xzf plaingym-deploy-vX.Y.Z.tar.gz
   mkdir -p /opt/plaingym/postgres
   cp deploy/compose.yaml deploy/Caddyfile deploy/update.sh deploy/rotate-key.sh \
     deploy/restore.sh deploy/lib.sh deploy/release-signing.pem /opt/plaingym/
   cp deploy/postgres/01-roles.sh /opt/plaingym/postgres/
   ```

   `update.sh` (which needs `lib.sh` and the release signing public key,
   `release-signing.pem`, beside it) is how you [update](update-by-hand.md),
   `rotate-key.sh` (also with `lib.sh`) replaces the encryption key
   ([self-hosting.md](self-hosting.md#rotating-the-encryption-key)), and `restore.sh`
   runs a [command-line restore](restoring.md#restore-from-the-command-line).
2. Copy the example environment file separately and switch to the install directory.

   ```sh
   install -m 600 deploy/.env.example /opt/plaingym/.env
   cd /opt/plaingym
   ```

   Replace every placeholder in `.env`.

   * `APP_IMAGE`: the version tag or digest;
   * `GYM_HOSTNAME` and `ACME_EMAIL`;
   * `POSTGRES_PASSWORD`, `APP_PASSWORD`, `MAINTENANCE_PASSWORD`, `AUTH_SECRET` and
     `SETUP_TOKEN`: independent random values (`openssl rand -hex 32` each);
   * `APP_ENCRYPTION_KEY`: 64 hex characters (`openssl rand -hex 32`);
   * `PLAINGYM_ORIGIN_NONCE` (uncomment it): any value, such as
     `openssl rand -hex 16`, for the origin check Caddy serves at
     `/.well-known/plaingym-origin`.

   If your hostname is proxied by Cloudflare, uncomment `TRUST_CLOUDFLARE=true` in
   `.env` so rate limits use each visitor's IP address. See the [Cloudflare proxy
   guide](cloudflare.md#set-it-up) for the DNS, TLS and rate-limiting settings; its
   installer step doesn't apply here, because you have just made that `.env` change
   yourself.
3. Start the stack and print the setup link from `/opt/plaingym`.

   ```sh
   docker compose up -d --wait
   docker compose exec -T app gym-app setup-link
   ```

Keep a copy of `.env` somewhere safe: it holds `APP_ENCRYPTION_KEY`. Memory limits,
`AUTH_PASSWORD_LOGIN`, the access log and the optional install-wide `SMTP_*` settings are
described in [`deploy/README.md`](../deploy/README.md) and [configuration.md](configuration.md).

### Adding the update timer

This route installs no update timer, so patch releases don't install themselves (the
Health page's **Automatic updates** tile says no check has run). To add it, install the two
units from the extracted `deploy/` folder (not `/opt/plaingym`, which has no `systemd/`) with
the install directory filled in. The timer verifies later releases with the
`release-signing.pem` you copied in [step 1](#route-3-docker-compose-by-hand); if
`/opt/plaingym/release-signing.pem` is missing (an install made without it),
copy it there first, as [Before you update](update-by-hand.md#before-you-update) says:

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
