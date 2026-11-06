<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Install guide

How to put PlainGym on a server, by one of three routes. All three end the same
way: Caddy, the app and PostgreSQL running in `/opt/plaingym`, a valid HTTPS
certificate, and a private setup link. The requirements (server, hostname, ports,
email, Stripe, backup bucket) are listed in [self-hosting.md](self-hosting.md#what-you-need);
read them first. Every setting is in [configuration.md](configuration.md).

You need an app image for your server's CPU (amd64 or arm64), named by version tag
(`ghcr.io/plaingym/app:vX.Y.Z`) or digest. The server never builds it. Where this
guide writes `vX.Y.Z`, put the version you are installing.

## Before you start

1. Point your hostname at the server with a DNS-only record: an A record, plus an
   AAAA record if the server has working public IPv6. A proxied record (for example
   Cloudflare's orange cloud) fails the installer's DNS check.
2. Open TCP 80 and 443, and your SSH port, in any firewall your provider runs in
   front of the server.
3. Decide which email address the certificate authority may contact. It is not your
   sign-in address.

The installer checks the hostname before it changes anything. If the name does
not resolve yet, check that its record points here. If you recently added or
changed the record, cached answers, including a cached answer that the record is
missing, can remain until their TTL expires, which can take an hour or more. Retry
the installer after that, using the command for your route below. A confirmed
address mismatch needs a DNS-only record pointing here. If the server has no
global IPv6 address, remove its AAAA record or configure working public IPv6.

When a hostname lookup fails, the installer also tries `api.ipify.org`. If neither
query succeeds, it says the server could not query DNS: check the server's DNS
resolver and network connectivity before retrying. If the public-address lookup
failed, check that `curl` is installed and outbound HTTPS works; the installer
could not confirm an address behind NAT. A confirmed mismatch takes priority
over an unconfirmed address. Each refusal confirms: "Nothing was changed."

## Route 1: one command

Use this when you have the deployment bundle (the `deploy/` folder of the release).
Copy it to the server, and from inside it run:

```sh
sudo sh install.sh --hostname gym.example.org --email owner@example.org \
  --image ghcr.io/plaingym/app:vX.Y.Z
```

If your bundle carries the image as a file, use `--image-archive FILE` in place of
`--image` (the image name is still required; the installer loads the archive).
To fetch and verify a bundle by URL first, `deploy/bootstrap.sh` does that and then
runs the installer; see "One command from a bundle" in
[`deploy/README.md`](../deploy/README.md#one-command-from-a-bundle).

The installer, in order:

1. checks the hostname's DNS;
2. installs Docker, turns on the firewall (SSH, 80, 443), unattended OS security
   updates and, when no swap is active, 1 GiB of swap;
3. writes `/opt/plaingym/.env` (mode 0600) with six independent random secrets;
4. starts Caddy, the app and PostgreSQL, and waits for a valid certificate and
   `https://gym.example.org/healthz`;
5. installs and starts the nightly update timer (`plaingym-update.timer`), which
   installs patch releases automatically ([updating.md](updating.md));
6. prints `https://gym.example.org/setup#token=…`.

Open that link and continue with the [setup wizard](self-hosting.md#setup-wizard).
Running the same command again is safe: it keeps `.env`, starts anything that has
stopped and prints the link again. It refuses a different hostname, email or image;
change the image with `update.sh` ([updating.md](updating.md)).

If the installer fails at the certificate step, check DNS and the firewall, then
`sudo docker compose logs caddy` in `/opt/plaingym`. Don't delete the database volume
to retry.

## Route 2: cloud-init

Many providers accept a cloud-init file as "user-data" when you create the server.
[`deploy/cloud-init.yaml`](../deploy/cloud-init.yaml) runs the same installer from a
reviewed commit of the public repository.

1. Copy the file and edit the placeholders in its script:
   * `commit=COMMIT`: a full 40-character commit SHA you have reviewed (the script
     refuses anything else);
   * `--hostname HOSTNAME` and `--email EMAIL`;
   * the image after `--image` (the file ships `ghcr.io/plaingym/app:v0.0.0`; use a
     real version tag or digest).
2. Create an Ubuntu 24.04 or 26.04 server with the file as user-data, and point the
   hostname's DNS at the server's address.
3. The script runs once at first boot. Create the DNS record **before** boot, or
   the installer stops at its DNS check; if that happened, fix the record, then SSH
   in and run `sudo sh /root/install-plaingym.sh` again. Cached answers for a record
   you just changed can remain until the old record's TTL expires, which can take
   an hour or more.
   If you used [`deploy/cloud-init-local.yaml`](../deploy/cloud-init-local.yaml)
   to test an unpublished bundle, its retry command is
   `sudo sh /root/install-plaingym-local.sh`.
4. Read the setup link from the installer's output, or print it on the server:

   ```sh
   cd /opt/plaingym
   sudo docker compose exec -T app gym-app setup-link
   ```

## Route 3: Docker Compose by hand

Use this on a server you already manage (Docker and Compose installed, ports 80
and 443 free). The installer's host changes (firewall, swap, OS updates and the
nightly update timer) are then yours to make.

1. Copy `compose.yaml`, `Caddyfile`, `postgres/01-roles.sh`, `update.sh`,
   `rotate-key.sh` and `lib.sh` from `deploy/` into `/opt/plaingym`, keeping the
   `postgres/` folder. The other guides assume that directory: `update.sh` (which
   needs `lib.sh` beside it) is how you update ([updating.md](updating.md)), and
   `rotate-key.sh` (also with `lib.sh`) replaces the encryption key
   ([self-hosting.md](self-hosting.md#rotating-the-encryption-key)).
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

This route installs no update timer, so patch releases don't install themselves
(the Health page's **Automatic updates** tile says no check has run). To add it,
copy `release-signing.pem` from `deploy/` into `/opt/plaingym` too when your copy of
the deployment files has one, then, from `deploy/`, install the two units with the
install directory filled in:

```sh
for unit in plaingym-update.service plaingym-update.timer; do
  sed 's#@ROOT@#/opt/plaingym#g' "systemd/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now plaingym-update.timer
```

Keep a copy of `.env` somewhere safe: it holds `APP_ENCRYPTION_KEY`. Memory
limits, `AUTH_PASSWORD_LOGIN`, the access log and the optional install-wide `SMTP_*`
settings are described in [`deploy/README.md`](../deploy/README.md) and
[configuration.md](configuration.md).

## After the install

1. Open the setup link and walk through the [setup wizard](self-hosting.md#setup-wizard).
   Download and store the backup private key when it is shown; it is shown once.
2. Add your plans, classes and waivers, then bring in your members
   ([importing.md](importing.md)).
3. Billing and member emails stay off until you turn them on ([going-live.md](going-live.md)).

## Check it works

* `https://gym.example.org/healthz` answers.
* In `/opt/plaingym`, `sudo docker compose ps` shows `caddy`, `app` and `postgres`
  running.
* After setup, the admin's **System health** page shows the running version, the
  last backup and any failure.
