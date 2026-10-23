<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Self-hosted VM QA

This extends the production-image harness in the parent directory. It exercises
the one-command install from a maintainer bundle (deploy/bootstrap.sh), the
private setup link, the browser wizard, unattended encrypted backups, and browser
restore on a second fresh Ubuntu host. It does not publish an image.

Use the repository's pinned Node and pnpm. On Windows put
C:\Program Files\nodejs first on PATH and use pnpm.cmd.

    pnpm --dir e2e install --frozen-lockfile
    pnpm --dir e2e exec playwright install chromium
    pnpm --dir e2e check-types
    node --experimental-strip-types --test e2e/vm/harness.test.mjs

Build committed application source with deploy/Dockerfile, then export it with
deploy/test/prepare-bundle.ps1 -Image YOUR_TESTED_IMAGE, which writes
deploy/dist/plaingym-ARCH.tar and prints its SHA256. Never build on either
target. The app image must match the target architecture; the local QEMU fixture
is amd64. For a remote run, upload the bundle and deploy/bootstrap.sh to private
HTTPS storage (deploy/README.md, **One command from a bundle**) and put both
links in bundle.url and bundle.bootstrapUrl: each host is installed with the
exact command an operator pastes, and re-pasting it is the re-run check.

Copy config.example.json into ignored e2e/coverage/vm.json, edit it there, and
keep credentials, setup links and backup keys out of Git. Paths resolve relative
to the private config file. SSH can use an agent, or ssh.identity and
ssh.knownHosts. Remote runs use strict host-key checking and public certificate
verification. Use an existing trusted host key and noninteractive root/sudo
access. Both targets must be explicitly marked fresh: true: the runner refuses
an existing /opt/plaingym or Docker installation.

    node e2e/run.mjs --vm e2e/coverage/vm.json --phase source
    # Move the gym's DNS record to the second fresh host.
    node e2e/run.mjs --vm e2e/coverage/vm.json --phase restore

The source phase installs, checks token-less first-boot writes/polling are 403,
and drives the entire owner/gym/pack/website/email/payments/backup wizard in a real
browser. SMTP and payments use their offered skip choices. A browser CSV import
and photo upload happen before backup-key confirmation, so the first scheduled
snapshot contains both witnesses. The test waits for the real minute scheduler;
it never edits a job, changes the clock or restarts the app to obtain that backup.

Restore retains the original gym hostname. Use that same URL on both targets
and move DNS between phases. Both hosts need working public ACME challenges when
installed. An optional address IP routes browser traffic to a host while
preserving Host, TLS SNI, Origin and cookies; it does not replace public DNS/ACME.
The restore phase reads the private witness from the source phase, installs the
second host, and enters the bucket, snapshot and age key in its wizard. It checks
the restored owner login, gym name, member ID, exact photo bytes, and paused
billing/member emails. No SQL or CLI writes configure or restore the gym.

The restore phase samples actual cgroup v2 current/peak/max/swap/event counters
for Caddy, app and Postgres at 500 ms intervals, plus host RAM, swap and OOM kills.
It checks the shipped 512/384/128 MiB caps and V8 256 MiB old-space flag. Twenty
hash/verify round trips through the deployed password adapter run alongside
concurrent API reads and an encrypted backup. The adapter is extracted from the
shipped source map; types are stripped on the maintainer machine before sampling.
The workload runs as a separate Node process inside the same app cgroup and
records its two-slot bound, queue peak, latency and RSS. SQL reads verify the
stored Argon2id parameters. HTTP checks prove a decomposed-Unicode password works
and a wrong password fails, within the production five-sign-ins/minute limit.
The extra maintenance snapshot is a QA load generator after the unattended owner
flow has passed. No auth throttling is disabled.
The benchmark temporarily caps that app container at one CPU, runs with
priority 10 and a 300-second maximum lifetime, and restores the original CPU
quota when it ends. It never edits the installed Compose or environment files.

Remote memory acceptance requires a real 1 GB guest with at least 1 GiB swap,
no container restart/OOM, and no host OOM delta. The proposed 600 MiB full-stack
peak remains an acceptance check. A local run is labelled local-only and cannot
decide the 1 GB memory policy.

For two simultaneously reachable hosts (including the local fixture), omit
--phase to run both phases in sequence. Setting resume: true in a private config
reuses recorded install evidence and a finished source witness; it does not
reset a partially completed wizard or erase a database.

An interrupted local test can use localSnapshotRetry only with the retained
scheduled-backup-verified.json proof. This makes a separate QA snapshot for the
recovery witness and records QA-RETRY as a failing finding. It cannot substitute
for scheduled-backup acceptance or run against a remote VPS. The one-time age
key is saved in the private witness draft before confirmation, so normal retries
do not lose it. A verified restore may be rechecked on resume without overwriting
its database again.

## Local Ubuntu guests

The fixture boots two Ubuntu 24.04 cloud images under QEMU TCG, each with its own
kernel, systemd, Docker daemon, filesystem and swap. Docker only hosts QEMU and
the S3-compatible Moto stand-in; the guest app runs production Compose.
Nothing binds a Docker socket into a gym container.

    node e2e/vm/local.mjs
    # Use the private config path it prints:
    node e2e/run.mjs --vm e2e/coverage/vm-local-TIMESTAMP/config.json

Docker and loopback ports 2241, 2242 and 443 on 127.0.0.1/127.0.0.2 must be free.
VM_SOURCE_SSH_PORT, VM_RESTORE_SSH_PORT, VM_SOURCE_HTTPS_PORT and
VM_RESTORE_HTTPS_PORT select unused local ports. Chromium remaps only its
connection destination, preserving the installer's HTTPS origin on port 443.
The outer test network uses 10.89.25.0/24 to avoid the guest Docker address pools;
the runner also preserves its gateway route. VM_CACHE_VOLUME can reuse a retained
verified cloud-image cache. The two local installs can run concurrently.
Without hardware virtualization (Docker Desktop on Windows 10 exposes no
/dev/kvm), QEMU emulates every guest instruction: a local run takes hours and
keeps several host CPUs busy. Use it to check the scripts; acceptance comes from
the real servers.
On Windows, E2E_BROWSER_CHANNEL=msedge selects installed Edge.
SSH_KEYSCAN can select a compatible scanner; the Windows fixture prefers Git's
OpenSSH when available. Keyscan is used only for newly created loopback guests.
An interrupted fixture can be attached with:
node e2e/vm/local.mjs EXISTING_ARTIFACT_DIRECTORY EXISTING_COMPOSE_PROJECT.
Reattachment preserves the disks, keys, config and ports, and recreates the
containers so current CPU limits apply. Guests default to VM_CPUS=1.5,
VM_SMP=2, priority 10 and VM_LIFETIME=4h. The boot deadline defaults to 30 minutes
and can be set with VM_BOOT_TIMEOUT_MS for one run. Do not use Compose start to
resume containers created before the CPU limits were added.

The local substitutions are automatic: guest /etc/hosts replaces public DNS,
Caddy uses its internal CA, and the guest OS trusts that CA before the installer's
normal verified HTTPS check. Browser certificate verification is relaxed only
for loopback fixtures; remote configs cannot enable this exception. Moto stands
in for the bucket (including multipart uploads); it does not prove real provider
credentials, public DNS, ACME issuance or 1 GB pressure. The Ubuntu publisher's
image checksum is verified and retained in the fixture cache.

## Results and gaps

Private artifacts contain install logs with setup tokens redacted, protected
install-link records, the age key/witness, raw memory samples, Argon2id timings
and findings.json. Browser traces, videos and screenshots are disabled for this
suite because wizard forms contain credentials and a one-time private key.
Keep the entire artifact directory private.

A failed re-run of the install command, a re-run that changes .env, compose.yaml
or the Caddyfile, or an invalid hostname or email that reaches a host change is
a product bug, and fails acceptance after the browser flow completes. A missing
setup link, CLI repair, manual environment/Compose edit, or a web-flow failure
must also stay a bug; never document it as an owner workaround. Presigned bundle
links are maintainer delivery until releases are published.

The runner never tears down or resets a remote host. After local QA, remove its
containers, VM disks and network (use the project printed by local.mjs):

    docker compose --env-file RUN_DIRECTORY/compose.env -p PROJECT -f e2e/vm/compose.local.yaml down --volumes --remove-orphans

The cloud-image cache is an external shared volume and survives this command.
Remove the project's two throwaway built image tags too. Keep the private
artifacts for review. Moto's bucket state is temporary; after an interrupted
fixture restart a local retry may need a fresh snapshot from the retained source
VM. No application/runtime dependencies were added; QEMU, cloud-image-utils and
Moto are test tooling only.
