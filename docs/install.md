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

1. Point your hostname at the server: an A record, plus an AAAA record if the
   server has working public IPv6. Cloudflare's proxy (the orange cloud) is
   recommended if your domain is on Cloudflare; see
   [Behind Cloudflare's proxy](#behind-cloudflares-proxy-recommended). Otherwise use
   a DNS-only record. Any other proxy fails the installer's DNS check.
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
