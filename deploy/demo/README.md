<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Demo server

One command on Ubuntu 24.04 or 26.04 LTS (amd64 or arm64) installs Docker,
preserves the SSH listener in the firewall, enables security updates, adds swap,
and starts Postgres, the app and a prebuilt Cloudflare-enabled Caddy. Images are
never built on the VPS. Docker logs rotate at 10 MB × 3 per container.

Create DNS-only A records for `demo.plaingym.app` and `*.demo.plaingym.app` pointing
at the VPS. Add AAAA only if the server has working public IPv6. Create a token
with **Zone Read** and **DNS Edit**, scoped to the domain's zone, and a dedicated
S3-compatible bucket with object read/write/delete credentials. R2 uses region
`auto`. These DNS records and API credentials are the only manual prerequisites.

The maintainer supplies an HTTPS bundle URL, SHA256 and bootstrap URL. Paste this
single command in an SSH terminal, substituting those three values:

```sh
curl --fail --silent --show-error --location --proto '=https' BOOTSTRAP_URL | sudo sh -s -- --bundle-url BUNDLE_URL --sha256 BUNDLE_SHA256
```

The bundle must match the server architecture. The command downloads and verifies
it, loads its prebuilt app and proxy images, and prompts for the demo domain,
ACME email, Cloudflare DNS token, S3 endpoint, bucket, access key and secret key.
Secrets are hidden at the terminal. They never need to be put in shell history,
`.env` or Compose by hand. It checks base and wildcard DNS against the server,
actually creates/deletes a temporary TXT record, and writes/reads/deletes a
temporary S3 object **before changing host configuration**. A failed check stops
with no host configuration written.

Success prints **https://demo.plaingym.app**. Open it, create a sandbox, and select
owner or coach in the demo controls. Everything about the sandbox happens in the
web interface. Email stays in its outbox, uploads are disabled, and it expires
after 24 hours. The sample [kiosk instructions](../../apps/server/src/demo/README.md)
use a full member name and PIN `2468`.

Optional billing credentials are listed in [the environment template](.env.example).
Add `DEMO_STRIPE_TEST_KEY` and `DEMO_STRIPE_WEBHOOK_SECRET` to the installation's
root-only `.env`, then recreate the app with its two Compose files. Use a secret
or restricted **test** key and the signing secret for one test-account endpoint
at `https://<GYM_HOSTNAME>/webhooks/stripe`; subscribe to
[`webhookEvents`](../../apps/server/src/infra/payments/setup.ts). Never use a live
key. The installer does not prompt for these optional values. With no key,
sandboxes still work, log the skipped billing seed, and show billing as
unconfigured. See the [demo mode guide](../../apps/server/src/demo/README.md)
for dispatch and credential handling.

Re-paste the same command to verify/recover the installation. It preserves all
secrets, data and the installed app pin, refreshes deploy files from the verified
bundle, and skips host setup on subsequent runs. The same bundle leaves files
and containers unchanged. A failed first start resumes with the saved configuration. Inputs may also
come from the named environment variables in `config.py`; `--hostname` and
`--email` are optional installer arguments after `--`. Existing installation
values take precedence. It refuses another install's directory or switching a
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

For a published app image, one command on the server is sufficient:

```sh
sudo /opt/plaingym-demo/update.sh ghcr.io/plaingym/plaingym:v0.2.1
```

For another unpublished build, use the same bootstrap command with the **new**
bundle URL and SHA256, adding `--update plaingym:v0.0.1-local`. No manual image
upload or `docker load` is needed. The maintainer must use a different app tag for
each bundle update; bundle preparation supports `-AppTag` for this purpose.
The command loads/pulls the target before downtime, stops writers, captures a
private pre-update database snapshot, starts the new app (migrations run at boot),
and publishes its image pin only after health checks. Failure restarts the
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
or digest when changing the Caddy image. The app-only `update.sh IMAGE` command
does not refresh deploy files. The bootstrap's `--update IMAGE` form first
refreshes deployment files, then runs that app update.

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

## Local validation

On Linux/WSL with Docker, Python 3 and a prebuilt app image:

```sh
sudo env DEMO_TEST_APP_IMAGE=plaingym:e2e sh deploy/demo/test-local.sh
```

It runs preflight failure tests, starts a pinned local Moto S3 service, runs the
real installer in `--local-test` mode (skips public DNS and host OS provisioning,
requires `.test`/`.localhost`, uses Caddy's local CA), and checks sandbox creation,
owner/coach login, rerun idempotence, verified deploy-file refresh, plaintext
snapshot permissions, default/custom retention, update and rollback. The browser client
trusts the exported local CA and uses actual HTTPS through the proxy. No public
API credentials are used. Test installations and logs use a private
`/tmp/plaingym-demo-test-*` directory so Linux permissions are tested even when
the checkout lives on Windows. Test resources have a unique Compose project and
are removed by the smoke's cleanup trap. It never touches a pre-existing
installation. The POSIX mode test and root bootstrap test explicitly skip on
Windows; run them on Linux/WSL for full coverage.
