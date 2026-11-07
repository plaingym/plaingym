<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Updating guide

How an install moves to a new release, and what to do if an update fails.
The reference description of the updater is in [self-hosting.md](self-hosting.md#updates)
and [`deploy/README.md`](../deploy/README.md#updates-and-recovery).

Releases are numbered `vX.Y.Z`. **Patch releases** (only Z changes: fixes, never
database changes) install themselves each night on an install set up with the
installer. **Minor and major releases** wait for you: owners and admins see an
"Update available" banner, and you run the update by hand (below).

## Patch releases: automatic

Each night, between 02:00 and 05:00 in the gym's timezone, the server's update timer
(`plaingym-update.timer`) looks for a newer patch release of the version it runs. If
there is one, it checks the release's signature, takes a backup, installs it, checks
that the app stays healthy, and goes back to the previous version if not. Owners turn
this off, or on again, in **Settings → Updates**; it is on by default. An install set
up by hand with Docker Compose has no timer until you add it
([install.md](install.md#route-3-docker-compose-by-hand)).

The Health page's **Automatic updates** tile shows the last night's result: up to
date, updated, rolled back, or skipped and why. To run the check at once, for
example after setting up backups:

```sh
sudo /opt/plaingym/update.sh --patch --now
```

| The tile says | What to do |
| :--- | :--- |
| Backups aren't set up | Set them up in **Settings → Email, payments and backups**; the next night's check installs the release. |
| The server has no release signing key | Copy `release-signing.pem` from the current deployment files into `/opt/plaingym`. |
| The list of releases, the manifest or the image couldn't be downloaded, or the backup before the update failed | Nothing was changed; the next nightly check tries again. Check the server's network, or the bucket under **Settings → Email, payments and backups**. |
| The signature didn't verify, the image doesn't match the manifest, or the patch changes the database | Nothing was installed, on purpose. Update by hand once a fixed release is out. |
| Version X was rolled back | The new version didn't start or failed its health check, and the previous one runs again. Read `sudo docker compose logs app` in `/opt/plaingym`. |
| The update failed and starting the previous version failed too | Check the containers with `sudo docker compose ps`. The updater tries to start the previous version again each hour until it runs. |
| No nightly update check since … | Check the timer: `systemctl status plaingym-update.timer`. The updater's log is `journalctl -u plaingym-update`. |

A newer patch release raises no banner while the nightly update is expected to install
it. When it won't (automatic updates are off, no nightly check has run for two days, or
the last check for that release skipped, rolled back or failed), the banner appears and
says why. If automatic updates are off or the timer has stopped, turn them on or fix the
timer, or install the release by hand as below. If the check was refused on purpose (the
signature, the image or the database row in the table above), don't install that release
by hand: update by hand once a fixed release is out. For any other reason, do what it
says. A failed check for an older patch raises nothing once a newer one is out, because
the next nightly check tries the newest.

## Minor and major releases: by hand

### Before you update

1. **Backups must be set up.** The updater takes a backup first and refuses to go on
   without one. Check the admin's **System health** page for a recent successful
   backup, or set backups up in **Settings → Email, payments and backups**.
2. **Keep your backup private key and a copy of `/opt/plaingym/.env`** somewhere off the
   server. If an update ever goes wrong beyond repair, they are what a
   [restore](restoring.md) needs.
3. **Choose a quiet time.** The app is stopped while the pre-upgrade backup runs and
   the new version starts.
4. Note the version you run now (the **System health** page shows it). Keep its image
   on the server until you are sure of the update.

### Update

Host files are copied only at installation; updating the app image does not
refresh scripts, Compose files, systemd units or `release-signing.pem`. Follow
the release's instructions to copy new or changed host files from its `deploy/`
directory into `/opt/plaingym` by hand, preserving your `.env` and local settings.
Installs made before key rotation was added must copy `rotate-key.sh` from the
release and make it executable before using it. Keep its companion `lib.sh` and
other host files at the versions required by that release.

While `/opt/plaingym/.rotate-key.inflight` exists, a manual update fails and
the nightly update skips, both saying that key rotation is unfinished. Rerun `rotate-key.sh` to finish
the rotation before updating; keep the marker and both keys until it succeeds.
Rotation temporarily revokes the app's database CONNECT privilege and waits up
to 30 seconds for existing sessions to close, refusing if any remain. It never
terminates sessions. A partial rewrite (maintenance exit code 2) or any uncertain
failure keeps the app stopped; rerun with the same keys in the marker. Rerunning also
restores CONNECT after a crash, including one after `.env` was already switched.
Only a definite preflight refusal (exit 3), with no earlier attempt that may have
committed pages, restores CONNECT and restarts the app with its old key. Repeated
clean refusals restart it each time so settings can be corrected in the admin;
a refusal after a partial or uncertain attempt keeps the fence and app stopped.
The marker records this distinction durably before each attempt. The one-off
command bypasses the image's normal entrypoint so a retained fence cannot block
the maintenance connection needed to finish the rotation.

On the server:

```sh
cd /opt/plaingym
sudo ./update.sh ghcr.io/plaingym/app:vX.Y.Z
```

The argument is an explicit version tag or `sha256` digest for your server's CPU
architecture. `latest` is refused. The script:

1. pulls the new image while the app keeps running;
2. stops the app and takes a pre-upgrade backup, encrypted to your backup key;
3. starts the new image, which applies its database migrations before it reports
   healthy;
4. records the new image in `.env` only once the new version is healthy.

It prints "Already on the requested image." and does nothing when you ask for the
version you run.

### If it stops

| What it says | What happened | What to do |
| :--- | :--- | :--- |
| "Backups are not set up: set them up in Settings → Email, payments and backups, then run the update again" | Nothing was changed; the current version was restarted. | Set up backups, run the command again. |
| "The pre-upgrade snapshot failed (reason above). Nothing was changed; the current version is restarting." | The snapshot failed (bucket unreachable, credentials changed). The line above it says why. | Check the bucket and credentials under **Settings → Email, payments and backups**, and `sudo docker compose logs app`; run again. |
| "Update failed; restarting the previous image." | The new version didn't start or didn't pass its health check. | The updater restarted the previous image and left the old image in `.env`. Read `sudo docker compose logs app` for the reason before trying again. Across a rollback floor it restarts the previous image only if nothing migrated ([below](#updating-across-a-rollback-floor)). |
| "The failed update changed the database, and … can't run on it." | An update across a rollback floor migrated the database, then failed. | [Restore](restoring.md#when-rollback-is-refused) the pre-upgrade snapshot the message names. |
| "Another update is running." | An `update.sh` is already running (it takes a lock). | Wait for it to finish. |
| "The app must be running before an update." | The app container is stopped. | `sudo docker compose up -d`, then update. |

### Roll back a release

From the installation directory, run `sudo ./update.sh --rollback`. The updater
selects the previous successful version from `version-history.tsv`, checks it
against every rollback floor recorded since installation, takes another snapshot,
and starts the previous image by its immutable digest. Keep that image locally.
The history records the attempt and outcome; the health page records a successful
rollback as a version change with its source and destination versions.

Running it again goes back one more version, as far as the floor allows, and never
forward to the version you just left. To go forward again, update to that release.

After a rollback the nightly update skips the release you left, and any older patch
of that minor, and the health page says why. A newer patch still installs by itself.
To take the skipped release anyway, update to it by hand.

The signed release manifest declares the oldest compatible code. If the previous
version is below that floor, the command changes no app, image pin or history and
names the pre-upgrade snapshot to [restore](restoring.md#when-rollback-is-refused).
Restore is also needed when the data itself is damaged. See [versioning.md](versioning.md)
for the compatibility window and major-release boundaries.

Keep `schema-compatibility.yaml` with this installation's database. The updater
passes its checked floor to both startup and migration; code below that floor
refuses to start. Do not remove it to bypass a rollback refusal.

### Updating across a rollback floor

A release's floor can be above your version: a major that breaks compatibility, or a
skipped minor such as 1.2 to 1.4. The update prints that first. Once that release has
migrated the database, your version can't run on it, so `--rollback` refuses and the
way back is the pre-upgrade snapshot.

If such an update fails, the updater stops the new version and checks the database:

* **Nothing was migrated.** The previous version starts again and the attempt leaves
  no trace in the floor. Fix the cause and update again.
* **The database changed.** The previous version stays stopped, and the updater names
  the pre-upgrade snapshot to [restore](restoring.md#when-rollback-is-refused). The
  floor stays recorded, even though startup failed.
* **The database can't be read.** The previous version stays stopped. Start PostgreSQL
  and run `update.sh` again, which also finishes an update that was killed part way.

### After the update

* Open **System health** and check the running version, the last backup and that
  nothing is failing.
* Sign in as staff and as a member to confirm the admin and portal load.
* Keep the previous image while you need `--rollback`. Pruning it removes that
  recovery option; `sudo docker image ls` lists local images.
