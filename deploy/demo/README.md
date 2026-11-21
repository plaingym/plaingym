<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Demo server

The demo domain's root is a server-rendered product page. An old `/demo` link
redirects to the root. **Try the demo** opens `/demo` on the shared, read-only
showcase at `showcase.<GYM_HOSTNAME>`, one level below the demo domain. While the
first showcase starts, the button is disabled and the page asks visitors to
reload. The adjacent link opens the configured source repository. Owner, coach
and student logins and the kiosk remain available. An edit offers
**Make my own copy**, signed in as the same role.
Private copies keep their own `/demo` start page with a deletion notice at the bottom:
the current expiry time, which activity moves later up to the 24-hour limit. The product page and showcase
show no deletion notice. Ordinary installs and gym website roots are unchanged.
The showcase is replaced 24 hours after promotion and runs no gym jobs. It stays
available until a replacement is ready if capacity delays the swap. Use the
one-click role logins; magic-link requests are refused on the shared showcase.
The showcase's `/login` page offers those role sign-ins in place of the email
form. When the per-network hourly limit refuses a new copy, **Make my own copy**
in the showcase's demo bar shows how many minutes to wait before trying again.

Optional settings accepted by the installer and saved in its protected `.env`:

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `DEMO_MAX_SANDBOXES` | `50` | Total cap including the showcase, ready pool and queued reservations. |
| `DEMO_POOL_SIZE` | `5` | Gyms seeded ahead, one at a time; 0 through `DEMO_MAX_SANDBOXES - 3`. Empty-pool visitors see their place in line. |
| `DEMO_IDLE_HOURS` | `2` | Private copy lifetime without requests; activity is persisted at most every five minutes, with a hard 24-hour limit after allocation. |

Keep settings identical across app processes. The pool-size boot check reserves
three slots for the showcase, its daily replacement and at least one private copy
(so the sandbox cap must be at least 3). Failed or interrupted seeds are discarded and replaced with fresh
gyms; Stripe test rate limits back off before failing a seed. Cleanup checks every
five minutes and logs individual failures while continuing with other gyms.
Background discovery polls do not extend a private copy's idle lifetime.

One command on Ubuntu 24.04 or 26.04 LTS (amd64 or arm64) installs Docker,
preserves the SSH listener in the firewall, enables security updates, adds swap,
and starts Postgres, the app and a prebuilt Cloudflare-enabled Caddy. Images are
never built on the VPS. Docker logs rotate at 10 MB × 3 per container.

The demo runs in multi-gym mode, so the app never holds the `maintenance`
database role: a one-shot `migrate` service applies migrations and exits before
the app starts, and the app refuses to start with maintenance credentials
([which process holds the role](../README.md#which-process-holds-the-maintenance-role)).

Sandboxes get their own names under the demo domain (`<id>.` and the domain). Give
the demo a domain of its own, such as `demo-example.org`, rather than a name under
a domain that serves anything else: visitors write what sandboxes show. Create A
records for the domain and its wildcard (`demo-example.org` and
`*.demo-example.org`) pointing at the VPS, both **Proxied** through Cloudflare
(recommended) or both DNS only. Add AAAA only if the server has working public
IPv6. Create a token with **Zone Read** and **DNS Edit**, scoped to the domain's
zone, and a dedicated S3-compatible bucket with object read/write/delete
credentials. R2 uses region `auto`. These DNS records and API credentials are the
only manual prerequisites.

Behind Cloudflare's proxy, set SSL/TLS to **Full (strict)**; Always Use HTTPS can
stay on, since Caddy gets its certificate through the DNS challenge. Cloudflare's
free edge certificate covers a zone and one level below it, which is why the demo
domain should be the zone itself: sandboxes one level further down (under
`demo.example.org`) need a paid edge certificate. Add a rate-limiting rule for both
names, for example
`((http.host eq "demo-example.org" or ends_with(http.host, ".demo-example.org")) and not starts_with(http.request.uri.path, "/assets/"))`,
50 matching requests per 10 seconds per IP, blocked for 10 seconds
([Cloudflare page](../../docs/cloudflare.md)). The free plan supports this path
exclusion. Keep it so cold loads after updates can fetch hashed static files.
Admin, portal and kiosk share one built HTML shell: each loads 32 declared
resources under `/assets/`, for 33 requests including HTML; only the HTML counts
against this rule. API calls, route imports, PWA files and browser icons are extra.
The web build reports the shell counts and fails if HTML plus declared resources
outside `/assets/` reach 25, reserving room below the limit for runtime traffic.
The installer recognizes Cloudflare's addresses (`deploy/cloudflare-ranges.txt`)
and writes `TRUST_CLOUDFLARE=true`, so sandbox rate limits count real visitors.
With the proxy, the DNS check can't see which server is behind it; the HTTPS check
that follows goes through the domain. The same limits as a proxied gym install
apply.

Saved and environment-supplied demo billing credentials are validated before DNS,
Cloudflare and S3 preflight requests. Optional interactive billing setup follows
those checks. The shared helper library must be present for installed commands;
an executable or exported function named `read_env` cannot bypass that check.

The maintainer supplies an HTTPS bundle URL, SHA256 and bootstrap URL. Paste this
single command in an SSH terminal, substituting those three values:

```sh
curl --fail --silent --show-error --location --proto '=https' BOOTSTRAP_URL | sudo sh -s -- --bundle-url BUNDLE_URL --sha256 BUNDLE_SHA256
```

The bundle must match the server architecture. The command downloads and verifies
it, loads its prebuilt app and proxy images, and prompts for the demo domain,
ACME email, Cloudflare DNS token, S3 endpoint, bucket, access key and secret key.
Prompts use the controlling terminal even when the bootstrap is piped into `sh`.
Secrets are hidden at the terminal. They never need to be put in shell history,
`.env` or Compose by hand. It checks base and wildcard DNS against the server (or
Cloudflare's proxy, for both names alike), actually creates/deletes a temporary TXT
record, and tries every kind of S3 request the app makes, under a temporary
`plaingym-preflight/` prefix it removes again: write, read, metadata read, listing,
a conditional write that must refuse to overwrite (storage that ignores
`If-None-Match` is refused), and a multipart upload started and aborted. All of
this happens **before changing host configuration**. A failed check stops with no
host configuration written, and names the S3 request that was refused. A key
deleted or narrowed after the install shows up later, as sandboxes that fail to
create.

Success prints the demo's address (`https://` and the demo domain). Open the showcase, then select
owner or coach from the start page or the **Demo menu**. Everything about the sandbox happens in the
web interface. Email stays in its outbox, uploads are disabled, and it expires
after two idle hours (at most 24 hours) when you make a private copy. The sample [kiosk instructions](../../apps/server/src/demo/README.md)
choose Name and PIN, then use a full member name and PIN `2468`.

Demo billing is optional ([the environment template](.env.example) lists the
values). After the required inputs, an install run from a terminal asks once
whether to set it up (default no). If yes, it reads `DEMO_STRIPE_TEST_KEY` and
`DEMO_STRIPE_WEBHOOK_SECRET` with hidden prompts, and refuses to go on if both are
left empty. An install without a terminal never asks, and neither does one with
either variable set in the environment: it takes both from there, or skips
billing when they are empty (`DEMO_STRIPE_TEST_KEY=` for a scripted install over
SSH). Use a secret or restricted **test** key
(`sk_test_…` or `rk_test_…`) and the `whsec_…` signing secret for one test-account
endpoint at `https://<GYM_HOSTNAME>/webhooks/stripe`; subscribe to
[`webhookEvents`](../../apps/server/src/infra/payments/setup.ts). A live key is
refused before anything is written, and no value is ever printed. A re-run keeps
saved values; a re-run on an install without them can add them (it asks again, or
reads the environment) and recreates the app. With no key,
sandboxes still work, log the skipped billing seed, and show billing as
unconfigured. See the [demo mode guide](../../apps/server/src/demo/README.md)
for dispatch and credential handling.

Re-paste the same command to verify/recover the installation. It preserves all
secrets, data and the installed app pin, refreshes deploy files from the verified
bundle, and skips host setup on subsequent runs. The same bundle leaves files
and containers unchanged. A failed first start resumes with the saved configuration. Inputs may also
come from the named environment variables in `config.py`; `--hostname` and
`--email` are optional installer arguments after `--`. Existing installation
values take precedence, so a re-run keeps the saved demo domain; a re-run adds
`TRUST_CLOUDFLARE=true` when the records have been proxied since, and keeps a saved
value. It refuses another install's directory or switching a
local install to public TLS. Default directory: `/opt/plaingym-demo`.

Caddy manages only the demo hostname and its wildcard, using the Cloudflare DNS
challenge. Sandbox creation requests no certificates. The stock image cannot
do this; the included proxy pins Caddy **2.11.7** and Cloudflare module **0.2.4**
(commit `a8737d095ad5a48ca031cea6ab704057dbc2d250`), with digest-pinned build and
runtime bases. Its upstream [module documentation](https://github.com/caddy-dns/cloudflare)
describes token permissions. `ACME_CA` can select the Let's Encrypt staging
directory before an initial install; production is the default. A staging
certificate is intentionally not accepted as public deployment success.

## Updates

### Automatic release updates

The installer installs `release-signing.pem` and `prerelease-signing.pem` and enables
`plaingym-demo-update.timer`. Existing demos receive these through the bootstrap
refresh described below. The timer fires hourly with up to 50 minutes of random
delay; it acts once between 02:00 and 05:00 in `DEMO_UPDATE_TIMEZONE` (default
`America/New_York`). It does not catch up outside that window.

By default the demo follows published prereleases and stable releases with the
running image's major version. It installs the **next** newer version, then the
next, in order while each update succeeds and the nightly window remains open.
Release history is paginated before selection (at most 1,000 entries; an
incomplete history is skipped). `DEMO_RELEASE_CHANNEL=stable` instead follows
the newest stable patch **or minor** release, as a single update. A new major
requires an explicit operator update. Tags and image labels use plain `vX.Y.Z`,
including nightly `v0.Y.Z` prereleases; development/bundle labels are skipped.
Set these host-only options in the root-only installed `.env`:

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `DEMO_AUTO_UPDATE` | `on` | `off` disables automatic updates, including `--now`. |
| `DEMO_RELEASE_CHANNEL` | `prerelease` | `prerelease` considers prereleases and stable releases in ascending version order; `stable` considers only the newest stable release. |
| `DEMO_UPDATE_TIMEZONE` | `America/New_York` | IANA timezone for the nightly window. |
| `RELEASE_REPOSITORY` | `plaingym/plaingym` | Repository publishing releases, including for forks. |

The GitHub prerelease flag selects one installed key: `prerelease-signing.pem`
for prereleases, `release-signing.pem` for stable releases. The signed manifest
must also have `channel=prerelease` for a prerelease and no channel for a stable
release. The keys are never tried interchangeably. The updater reuses the
self-hosted manifest/signature, deploy-archive checks, host-file journal and
timezone window, and selects releases with its own channel-aware helper; it pulls the manifest's
`IMAGE:vX.Y.Z@sha256:DIGEST` and checks the registry digest and version label
before stopping the app. Invalid signatures, manifests, digests, labels and
archives are refused permanently for that tag, even with `--now`. On `stable`,
a newer tag can be considered. On `prerelease`, a refusal or exhausted attempts
stop ordered catch-up at that tag; an explicit update is needed to pass it.
Network failures can be tried on a later night. As on
self-hosted installs, a release whose signed `rollback_floor` is above the
running version is skipped with `rollback_floor_above_running`, since the
running image couldn't restart on its migrated database; install it explicitly.
Failed update attempts are limited to two per release, counting interrupted
attempts. Catch-up stops at the first failure; an earlier successful update
remains the running pin and rollback target. A night when the app
isn't running is skipped with `app_not_running` and uses no attempt. `--now`
bypasses the clock, but keeps these trust checks and attempt limits.

The install/update lock prevents concurrent changes. A busy lock skips that
night. Updates send SIGTERM and wait up to 30 minutes for the worker's in-flight
seed to finish; they never force-kill it. If draining times out, the pin and
deploy files stay unchanged; the next hourly updater run, at any time of day,
waits for the drain, restarts the pin and proxy and reports recovery. An
explicit `update.sh IMAGE` does the same recovery first, then installs `IMAGE`.

Changed demo scripts, Compose files, systemd units and Caddy configuration come
only from the verified release archive. Credentials, the app pin and the Caddy
image stay in place until the normal update health checks commit the new app
pin. Failed refreshes restore the preceding files and proxy configuration before
restarting the old image. A host-file journal recovers interrupted refreshes.
Both installed signing keys are retained, never automatically rotated. The
archive's `release-signing.pem` must match the key selected for that release;
this slot carries the prerelease key in a prerelease archive and does not
replace either installed key. If the archive's demo
Caddy Dockerfile differs from the installed build recipe, the release is skipped
with `caddy_image_required`: releases do not publish the custom demo proxy image.
Refresh the bundle and its Caddy image explicitly, then install that app release
explicitly or wait for a newer tag.

```sh
sudo /opt/plaingym-demo/update.sh --auto --now
sudo /opt/plaingym-demo/update.sh --status
sudo journalctl -u plaingym-demo-update.service
sudo systemctl list-timers plaingym-demo-update.timer
```

Each nightly action writes a summary (up to date, updated from/to, rolled back,
or skipped with its reason) to the journal and `auto-update.status`. Off-window,
already-checked and disabled runs are quiet. No gym email configuration is needed.

### Explicit updates

For an explicit published app image, one command on the server is sufficient:

```sh
sudo /opt/plaingym-demo/update.sh ghcr.io/plaingym/app:v0.2.1
```

This is also the one-time switch from a bundle image to nightly prereleases:
substitute the newest published prerelease's actual tag. Refresh the demo bundle
first to install these scripts and both public keys. The update installs the
deploy files from that release's archive, so pick a prerelease that already
includes this updater: an older one would put back an updater that ignores
prereleases. Explicit `IMAGE:vX.Y.Z` updates
look up that published tag and perform the same signature, channel, archive,
digest, label and Caddy checks as automatic updates, then pin the signed digest.
They accept a prerelease even when the automatic channel is `stable` and can
cross its rollback floor; they do not depend on a release label on the running
bundle image. The operator runs this switch; the nightly updater keeps skipping
the bundle image until then.

For another unpublished build, use the same bootstrap command with the **new**
bundle URL and SHA256, adding `--update plaingym:v0.0.1-local`. No manual image
upload or `docker load` is needed. The maintainer must use a different app tag for
each bundle update; bundle preparation supports `-AppTag` for this purpose.
The command loads/pulls the target before downtime, drains the worker and stops writers, captures a
private pre-update database snapshot, applies migrations with the one-shot
`migrate` service, starts the new app, and publishes its image pin only after health checks. Failure restarts the
previous image by ID; the old pin stays in place. Snapshot files remain in the
root-only `snapshots/` directory (`0700`), as unencrypted `pg_dump` archives (`0600`).
These short-lived local rollback copies contain the database, including its
encrypted settings; they do not protect against a compromised root account or
server loss. Keeping a second encryption key beside the files would not improve
that boundary. This avoids another crypto format beside the app's age backups.
Changes must retain the app's expand-only
migration compatibility for rollback. The demo uses this snapshot path because
its disposable gyms have no backup destination configured.

After each successful update, retention keeps the **newest 3** snapshots. Failed
updates keep their snapshot and do not prune anything. Existing `.dump.enc` files
count toward retention too; they are not converted. Choose another positive
count at initial install with `-- --snapshot-retention 5`, or for an update with
`sudo env DEMO_SNAPSHOT_RETENTION=5 /opt/plaingym-demo/update.sh IMAGE`. For a
bundle update, put `sudo env DEMO_SNAPSHOT_RETENTION=5 sh -s -- ...` after the
bootstrap download pipe. No `.env` edits are needed.

### Refreshing deployment files

Re-run the bootstrap with a new bundle URL and its **new SHA256**, without
`--update`, to refresh the demo scripts, both Compose files, Caddyfile and
prebuilt Caddy image. Existing credentials and the app image pin are preserved;
the proxy pin is published after health checks. A failed refresh restores the
previous deploy files, configuration and proxy. Use a new immutable version tag
or digest when changing the Caddy image. Published `update.sh IMAGE:vX.Y.Z`
updates also refresh deployment files from their verified release archive.
Bundle/local image updates keep the files installed by the bootstrap. The
bootstrap's `--update IMAGE` form first refreshes deployment files, then runs
that bundle app update. A refresh installs missing public keys beside existing
ones and preserves either key already installed.

The local smoke verifies this with a checksum-verified HTTPS bundle, changed
scripts/Compose/Caddyfile, a new proxy reference and unchanged app/secrets. It
also verifies rollback from an invalid Caddyfile and preserved sandbox sessions.

## Maintainer bundle

On a development machine with Docker and PowerShell, build and test the app, then:

```powershell
# Node 24.22.1 must be first on PATH for all pnpm commands.
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
./deploy/demo/prepare-bundle.ps1 -Image plaingym:e2e -Architecture amd64
```

This reuses `deploy/test/prepare-bundle.ps1` for the app export, builds the proxy
locally and writes `deploy/demo/dist/plaingym-demo-amd64.tar`. Choose `arm64` with
a matching app image for ARM. The script prints the SHA256 and the ready-to-paste
bootstrap command with URL placeholders. The archive includes only an explicit
deployment file list and saved images, never worktree environments or credentials.
With published images, run `deploy/demo/install.sh --image IMAGE --caddy-image IMAGE`
from the deployment bundle; both references must have a version or digest.

### Host the bundle in the existing R2 bucket

On the maintainer's machine, use the operator's existing R2 bucket and object
credentials. With the AWS CLI installed locally, configure a profile (enter the
R2 access key, secret key, region `auto`, and output `json` at its prompts), then
upload the bundle and this commit's bootstrap script under checksum-specific keys:

```powershell
aws configure --profile plaingym-demo
$r2Endpoint = 'https://ACCOUNT_ID.r2.cloudflarestorage.com'
$bucket = 'EXISTING_OPERATOR_BUCKET'
$archive = './deploy/demo/dist/plaingym-demo-amd64.tar'
$sha256 = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
$bundleKey = "deploy/$sha256/plaingym-demo-amd64.tar"
$bootstrapKey = "deploy/$sha256/bootstrap.sh"
aws s3 cp $archive "s3://$bucket/$bundleKey" --profile plaingym-demo --endpoint-url $r2Endpoint --region auto
aws s3 cp ./deploy/demo/bootstrap.sh "s3://$bucket/$bootstrapKey" --profile plaingym-demo --endpoint-url $r2Endpoint --region auto --content-type text/x-shellscript
$bundleUrl = aws s3 presign "s3://$bucket/$bundleKey" --profile plaingym-demo --endpoint-url $r2Endpoint --region auto --expires-in 86400
$bootstrapUrl = aws s3 presign "s3://$bucket/$bootstrapKey" --profile plaingym-demo --endpoint-url $r2Endpoint --region auto --expires-in 86400
"curl --fail --silent --show-error --location --proto '=https' '$bootstrapUrl' | sudo sh -s -- --bundle-url '$bundleUrl' --sha256 $sha256"
```

Give the operator that final command and the SHA256 through the trusted handoff.
Quote both URLs because their query strings contain `&`. The URLs grant GET
access to those two objects for 24 hours; the bucket stays private. Presign again
if a URL expires. The bundle's checksum, computed locally and checked before
extraction/execution, remains the trust anchor. Use the same commands for each
new bundle and its new checksum; no new hosting service or server-side upload
step is needed. These commands follow Cloudflare's [AWS CLI example](https://developers.cloudflare.com/r2/examples/aws/aws-cli/)
and [presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

Host setup (Docker, firewall, unattended upgrades, swap) is the shared
`deploy/host.sh` that the gym installer also runs, so there is one copy; shared
configuration helpers come from `lib.sh`.

The demo needs Docker Compose 2.24 or later (its overlay uses `!reset`). `install.sh`
(every mode, including `--local-test` and a re-install) and `update.sh` check it
first, before the host setup or any write, and stop with the version found if
it is older or unreadable; upgrade Compose the way it was installed (the
`docker-compose-plugin` package or your distribution's Compose package). A first
install on a host with no Compose gets one from the host setup, and `install.sh`
checks again once that setup has run (stopping before it writes or starts
anything if Compose is still missing or too old); a re-install, `--local-test`
and `update.sh` refuse without it. `install.sh --check-only` makes the same check
as the install it previews, so it needs Compose too, except where a first install
would add it. Run it with sudo on an installed host: without root it can't read the
install's `.env`, so it checks as a first install would.

`lib.sh` loads the shared helpers from `base-lib.sh` beside it. Only `install.sh`
may run without that copy (it carries the helpers itself and copies the file in,
so running it again restores a lost one; if that re-install fails, the rollback
removes the copy again with the rest of its changes); `update.sh` and anything
else that loads the installed `lib.sh` stops with a message naming the missing
file, whatever the caller's environment says.

The installer validates and checks the required inputs (domain, images, DNS,
Cloudflare, S3) before it asks about demo billing, so a mistake there is reported
before a key is typed. A saved key with no saved secret is completed from
`DEMO_STRIPE_WEBHOOK_SECRET` or a hidden prompt on the next run (no prompt when
either billing variable is set in the environment, even empty), and the
missing value is added to the saved `.env`. A saved key is never replaced; a key
added on a re-run brings the secret given with it, in place of any saved one.
Ctrl+C at any prompt ends with the same one-line failure message as any
other preflight failure.

## Local validation

On Linux/WSL with Docker, Python 3 and a prebuilt app image:

```sh
sudo env DEMO_TEST_APP_IMAGE=plaingym:e2e sh deploy/demo/test-local.sh
```

It runs preflight failure tests, starts a pinned local Moto S3 service, runs the
real installer in `--local-test` mode (skips public DNS and host OS provisioning,
requires `.test`/`.localhost`, uses Caddy's local CA), and checks sandbox creation,
owner/coach login, rerun idempotence, verified deploy-file refresh, plaintext
snapshot permissions, default/custom retention, timer installation, update and rollback.
The release fixtures use a fake clock, fake Docker/release responses and real
Ed25519 signatures to cover selection, refusal, retries and deploy-file recovery.
The browser client
trusts the exported local CA and uses actual HTTPS through the proxy. No public
API credentials are used. Test installations and logs use a private
`/tmp/plaingym-demo-test-*` directory so Linux permissions are tested even when
the checkout lives on Windows. Test resources have a unique Compose project and
are removed by the smoke's cleanup trap. It never touches a pre-existing
installation. The POSIX mode test and root bootstrap test explicitly skip on
Windows; run them on Linux/WSL for full coverage.
