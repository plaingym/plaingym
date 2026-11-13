<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Install guide

How to put PlainGym on a server, by one of three routes. All three end the same
way: Caddy, the app and PostgreSQL running in `/opt/plaingym`, a valid HTTPS
certificate, and a private setup link. The requirements (server, hostname, ports,
email, Stripe, backup bucket) are listed in [self-hosting.md](self-hosting.md#what-you-need);
read them first. Every setting is in [configuration.md](configuration.md).

Each release is a version, `vX.Y.Z`; where this guide writes `vX.Y.Z`, put the
version you are installing. Route 1 takes the app image from the release itself.
The other routes need the image named by version tag
(`ghcr.io/plaingym/app:vX.Y.Z`) or digest; it covers amd64 and arm64. The server
never builds it.

## Before you start

1. Point your hostname at the server: an A record, plus an AAAA record if the
   server has working public IPv6. Cloudflare's proxy (the orange cloud) is
   recommended if your domain is on Cloudflare; see
   [Behind Cloudflare's proxy](#behind-cloudflares-proxy-recommended). Otherwise use
   a DNS-only record. Any other proxy fails the installer's DNS check.
2. Open TCP 80 and 443, and your SSH port, in any firewall your provider runs in
   front of the server.
3. Decide which email address the certificate authority may contact. It is not your
   sign-in address.
4. If the gym will send email, check that the server can reach your email
   service. Many providers (DigitalOcean among them) block outbound SMTP on ports
   25, 465 and 587. Use an alternative port your email service offers (Mailgun's
   2525, for example), or ask the provider to unblock the account. The setup
   wizard's test email shows whether it gets through.

The installer checks the hostname before it changes anything. If the name does
not resolve yet, check that its record points here. If you recently added or
changed the record, cached answers, including a cached answer that the record is
missing, can remain until their TTL expires, which can take an hour or more. Retry
the installer after that, using the command for your route below. A confirmed
address mismatch needs a DNS-only record pointing here. If the server has no
global IPv6 address, remove its AAAA record or configure working public IPv6.

When a hostname lookup fails, the installer also tries `api.ipify.org`. If neither
query succeeds, it says the server could not query DNS: check the server's DNS
resolver and network connectivity before retrying. An address that isn't on this
server's network interfaces makes the installer look up its public address. If
that lookup failed, or a filtering proxy or captive portal answered with something
other than an address, the installer could not confirm an address behind NAT:
check that `curl` is installed and outbound HTTPS works with no filtering proxy or
captive portal in the way. A confirmed mismatch takes priority over an unconfirmed
address. Each refusal confirms: "Nothing was changed."

Before it prints the private setup link, the installer also fetches a random
value of this install's through the hostname (`/.well-known/plaingym-origin`, served
by Caddy). If what answers isn't this server, it stops without printing the link,
so the link's secret never goes to another server.

## Behind Cloudflare's proxy (recommended)

If your domain is on Cloudflare, put the server behind its proxy from the start:
floods and TLS are then handled at Cloudflare's edge, and the server's address never
appears in public DNS. The installer needs no option for it:

1. In Cloudflare, make the record **Proxied** (orange cloud) and under **SSL/TLS**
   choose **Full (strict)**. **Always Use HTTPS** can stay on: the server gets its
   certificate from Let's Encrypt through the proxy, over plain HTTP on
   `/.well-known/acme-challenge/`, and Cloudflare doesn't redirect that path. Don't
   add a redirect or rule of your own for it.
2. Run the installer as usual. Its DNS check recognizes Cloudflare's addresses
   (`deploy/cloudflare-ranges.txt`) and writes `TRUST_CLOUDFLARE=true` to `.env`, so
   the app reads each visitor's address from Cloudflare's `CF-Connecting-IP` header,
   but only on requests that arrive from Cloudflare's published ranges. Rate limits
   and sign-in limits then count real visitors, not Cloudflare's edge.
3. **Add a rate-limiting rule in Cloudflare** (Security → WAF → Rate limiting
   rules; the free plan includes one): match your hostname (expression
   `(http.host eq "gym.example.org")`), count requests per IP, and block an address
   that sends more than 50 requests in 10 seconds, for 10 seconds. The proxy alone
   passes a single noisy client on to your server; this rule refuses it at the
   edge. 50 in 10 seconds matches the app's own limit (`RATE_LIMIT_PER_MINUTE`, 300
   a minute by default); don't set it lower. Members on the gym's Wi-Fi share one
   address, so if they get blocked before a busy class, raise it (100 in 10 seconds,
   say). A blocked visitor gets Cloudflare's plain `error code: 1015` page (HTTP
   429) until the block ends; in the app, the screen shows its usual error and
   works again when retried.

Limits: the server also accepts connections that don't come through the proxy, so
someone who learns its address can reach it directly, around Cloudflare's
protections. Cloudflare's ranges are shared by every Cloudflare customer, so traffic
sent from inside Cloudflare's network can set `CF-Connecting-IP` itself and get
around per-address limits (not sign-in itself, and not the per-account sign-in
limit). Keep the server's address private: proxy the record before the first
install rather than after, so the address never appears in public DNS.

If the certificate isn't issued, check that the record is proxied, SSL/TLS is Full
(strict) and no rule of yours redirects or blocks `/.well-known/acme-challenge/`
(Caddy first tries a TLS check that Cloudflare's proxy can't pass, so a
`Cannot negotiate ALPN protocol "acme-tls/1"` line in its log is expected); then `sudo docker compose logs caddy` in the install
directory. If the installer says the hostname answered with an HTTP error, a
Cloudflare security setting (Bot Fight Mode, Under Attack mode, a WAF or
rate-limiting rule) may be challenging it: allow `/.well-known/plaingym-origin` and
re-run with the same options. The server is installed either way; only the setup
link waits for the check.

If you proxy the record after installing, re-run the installer with the same options
so the app trusts Cloudflare's header; until then every visitor counts as one of
Cloudflare's addresses for rate limits. An install whose `compose.yaml` and Caddyfile
predate proxy support refuses that re-run until you copy both from the current
deployment files. When Cloudflare's published ranges change, a release updates both
pinned lists.

## Route 1: one command

Pick the release to install on the
[releases page](https://github.com/plaingym/plaingym/releases), then run this on
the server, with that version in the address (both places it says `vX.Y.Z`) and
your hostname and email:

```sh
curl -fsSL https://github.com/plaingym/plaingym/releases/download/vX.Y.Z/bootstrap.sh \
  | sudo sh -s -- --hostname gym.example.org --email owner@example.org
```

Each release publishes its own `bootstrap.sh`, holding that release's version and
the project's release signing public key (`deploy/release-signing.pem`). Before it
installs anything, it:

1. downloads the release's manifest (`release-manifest.txt`) and its signature, and
   checks the signature with that key;
2. downloads the deployment files (`plaingym-deploy-vX.Y.Z.tar.gz`, the release's
   `deploy/` folder) and checks them against the SHA-256 the signed manifest lists;
3. runs the archive's full manifest validator, and checks that the release has an
   image for this server's CPU and that the archive carries the same signing key;
4. runs the archive's `install.sh` with the image digest and release repository
   (so a fork's updates keep using that fork).

If any check fails it stops with "Nothing was changed", and it leaves no downloaded
files behind either way. The files must come from the release you install: the
installer copies their `release-signing.pem` into `/opt/plaingym`, and the nightly
updater checks every later release with it.

Trust starts with the HTTPS download of `bootstrap.sh` from `github.com`: whoever
can change that file can change what it checks. To read it before running it,
download it first (`curl -fsSLO …/vX.Y.Z/bootstrap.sh`), check that its
`release_key=` line matches the body of `deploy/release-signing.pem` in the
repository, then run `sudo sh bootstrap.sh --hostname … --email …`.

If you already have the deployment files of a release on the server (its
`plaingym-deploy-vX.Y.Z.tar.gz`, unpacked), you can run the installer from that
`deploy/` folder yourself, with the same release's image:

```sh
sudo sh install.sh --hostname gym.example.org --email owner@example.org \
  --image ghcr.io/plaingym/app:vX.Y.Z
```

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
[`deploy/cloud-init.yaml`](../deploy/cloud-init.yaml) downloads and runs the same
release bootstrap as Route 1, including the signed manifest and archive checks.

1. Copy the file and edit the placeholders in its script:
   * `version=VERSION`: the release tag to install (`vX.Y.Z`);
   * `--hostname HOSTNAME` and `--email EMAIL`.
   For a fork, change the download URL's repository too; its release bootstrap
   carries the fork's signing key and updater repository.
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
