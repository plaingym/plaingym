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
([install.md](install.md#route-3-docker-compose-by-hand)). The timer asks the app for
the gym's timezone every hour, so after you change it the next night in the new
timezone counts.

A release that fails (it is rolled back, or the update and its rollback fail) is tried
once more the next night. If it fails again, automatic updates wait for a newer patch
release instead of trying it every night; the tile and the owner notice say so. To try
it again yourself, run `sudo /opt/plaingym/update.sh --patch --now`.

The Health page's **Automatic updates** tile shows the last night's result: up to
date, updated, rolled back, or skipped and why. After a later check it still names the
last update (or the last attempt that was rolled back or failed), with its date. A
stale error keeps its cause and adds the time of the last check in the gym's timezone.
After a [restore](restoring.md) it shows only this server's checks, not those of the
server the backup came from. With SMTP configured, each
owner receives one notice per rolled-back or failed attempt; replaying a report
does not send the same notice again. While the app is down no email can go out: if an
update and its rollback both fail, you hear about it once the app runs again, in a
notice that says when the site went down and when the hourly check started the previous
version again. To run the check at once, for
example after setting up backups:

```sh
sudo /opt/plaingym/update.sh --patch --now
```

An SMTP refusal does not delay later results on the health tile. The host keeps refused notices separately
and retries each on its next run, with the same per-owner delivery key. An unsent failed-rollback notice is
replaced by the recovery notice for that outage. Accepted or uncertain sends are never repeated. Other
notice errors, such as unreadable SMTP settings, are logged in the updater journal without blocking results.

| The tile says | What to do |
| :--- | :--- |
| Backups aren't set up | Set them up in **Settings → Email, payments and backups**; the next night's check installs the release. |
| The server has no release signing key | Re-run `install.sh` from the current deployment files with `--image` set to the running image, or copy `release-signing.pem` into the install directory (normally `/opt/plaingym`). |
| The list of releases, the manifest or the image couldn't be downloaded, or the backup before the update failed | Nothing was changed; the next nightly check tries again. Check the server's network, or the bucket under **Settings → Email, payments and backups**. |
| The signature didn't verify, the image doesn't match the manifest, or the patch changes the database | Nothing was installed, on purpose. Update by hand once a fixed release is out. |
| Version X was rolled back | The new version didn't start or failed its health check, and the previous one runs again. Read `sudo docker compose logs app` in `/opt/plaingym`. |
| The update failed and starting the previous version failed too | Check the containers with `sudo docker compose ps`. The updater tries to start the previous version again each hour until it runs. |
| The update and its rollback failed, so the site was down from … until … | The hourly check started the previous version again. Read `sudo docker compose logs app` for why the new version and the restart failed. |
| Version X failed twice, so automatic updates will wait for a newer patch release | Automatic updates skip that release from now on. Read `sudo docker compose logs app`; to try it again, run `sudo /opt/plaingym/update.sh --patch --now`. A newer patch installs by itself. |
| No nightly update check since … | Check the timer: `systemctl status plaingym-update.timer`. The updater's log is `journalctl -u plaingym-update`. |

A newer patch release raises no banner while the nightly update is expected to install
it. When it won't (automatic updates are off, no nightly check has run for two days, or
the last check for that release was held, rolled back or failed), the banner appears and
says why. If automatic updates are off or the timer has stopped, turn them on or fix the
timer, or install the release by hand as below. If the check was refused on purpose (the
signature, the image or the database row in the table above), don't install that release
by hand: update by hand once a fixed release is out. For any other reason, do what it
says. A failed check for an older patch raises nothing once a newer one is out, because
the next nightly check tries the newest.

A transient download, pull, backup or app-check failure raises the banner only
after two consecutive skipped attempts. A new install gets 50 hours from its
first health check before a missing nightly timer raises the banner, including
on a hand-installed Compose deployment. An invalid `RELEASE_REPOSITORY` also
raises a warning: patches cannot install until it is a valid `owner/name` and
the app is restarted. Neither path segment may consist only of dots.

After a successful automatic or manual update, the updater keeps the current image and the two
before it, so `--rollback` can go back up to two versions. It removes the images of
older versions (the installer's included, once it is three updates back) and the images
it pulled for releases that were rolled back. It never forces a removal or runs a global
image prune; images pulled by other tools are left alone.

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

The updater refreshes `update.sh`, `lib.sh`, `rotate-key.sh`, `restore.sh` and both systemd units
with the release.
The updater checks the signed manifest, the deployment archive and every host-file
digest before stopping the app. Once the app is healthy, it replaces each file by
an atomic rename and reloads systemd. The running updater finishes from the file
it opened; the next run uses the new one. The updater preserves `.env`, Compose,
Caddy and PostgreSQL configuration. A release changing those configuration files
still names the required manual steps in its upgrade notes.

Previous copies stay in `.host-history/`, associated with the image they ran with.
A failed replacement restores them before restarting the previous image. After a
power loss, the next invocation recovers `.host-update` before doing another update.
`--rollback` restores the previous host files and units when a saved copy exists.
Do not remove these directories while an update or recovery is unfinished.

The signing key must remain the currently trusted key. A release cannot rotate it
automatically, and rolling back never restores an older signing key. If a signing
key must change, verify the replacement through the maintainer's trusted release
instructions and install it explicitly before updating. This is separate from
rotating the installation's encryption key with `rotate-key.sh`.

Installs whose updater predates host-file updates need a one-time manual copy of
reviewed `update.sh` and `lib.sh` before using this mechanism: until then, they refuse
releases that carry host-file digests, and nightly updates skip them. Older signed
releases without host-file digests still update only the image.

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
an exit-3 refusal after a partial or uncertain attempt keeps the fence and app
stopped. A refusal that finds a value neither key opens and none under the new
key (exit 4) proves no attempt committed anything, so it restarts the app too.
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
4. installs the verified host files and units, keeping the previous copies;
5. records the new image in `.env` only once the new version is healthy, as
   `IMAGE:vX.Y.Z@DIGEST` from the signed release manifest.

An image with a release version label requires its signed release manifest and signature, even when
the image came from a mirror or a local build. There is no verification override. For a fork, set
`RELEASE_REPOSITORY=owner/repository` in the install's `.env` to the GitHub repository publishing its
signed releases and install its release signing public key. A network outage, missing release assets,
invalid signature or digest mismatch stops the update while the current app keeps running. Check the
reported repository and release, restore network access or publish the correct signed assets, then retry.

It prints "Already on the requested image." and does nothing else when you ask for the
image you run, by its tag or its digest.

### If it stops

| What it says | What happened | What to do |
| :--- | :--- | :--- |
| "Backups are not set up: set them up in Settings → Email, payments and backups, then run the update again" | Nothing was changed; the current version was restarted. | Set up backups, run the command again. |
| "The pre-upgrade snapshot failed (reason above). Nothing was changed; the current version is restarting." | The snapshot failed (bucket unreachable, credentials changed). The line above it says why. | Check the bucket and credentials under **Settings → Email, payments and backups**, and `sudo docker compose logs app`; run again. |
| "Update failed; restarting the previous image." | The new version didn't start or didn't pass its health check. | The updater restarted the previous image and left the old image in `.env`. Read `sudo docker compose logs app` for the reason before trying again. Across a rollback floor it restarts the previous image only if nothing migrated ([below](#updating-across-a-rollback-floor)). |
| "The failed update changed the database, and … can't run on it." | An update across a rollback floor migrated the database, then failed. | Retry the same release with `sudo ./update.sh IMAGE`, or update to a newer compatible signed release, even while the app is stopped or restarting. To go back, [restore](restoring.md#when-rollback-is-refused) the snapshot the message names. |
| "Update failed; the previous version stays stopped." | A retry after a migrated update failed. The previous version can't run on the database, so nothing restarts. | Read `sudo docker compose logs app`, then follow the next message: retry, or update to a newer compatible signed release. |
| "Recovery requires … or a newer compatible signed release." or "Recovery requires a release whose rollback floor covers …" | The requested release can't recover this install ([below](#updating-across-a-rollback-floor)). Nothing was changed. | Use the failed release again or a newer compatible signed release, or restore the snapshot. |
| "The recovery image is missing or incompatible." | The failed release's image is no longer on the server, so forward recovery can't take its snapshot. The app stays stopped. | Pull that release's image again and retry, or [restore](restoring.md#when-rollback-is-refused) the pre-upgrade snapshot. |
| "Another update is running." | An `update.sh` is already running (it takes a lock). | Wait for it to finish. |
| "The app must be running before an update." | The app is stopped and no migrated update is recorded for recovery. | Read `sudo docker compose logs app`. If the current release will not start, run `sudo ./update.sh --rollback`; the recorded floor still applies. If an update migrated and failed, retry its release or a newer compatible signed release as [below](#updating-across-a-rollback-floor). |

### Roll back a release

From the installation directory, run `sudo ./update.sh --rollback`. The updater
selects the previous successful version from `version-history.tsv`, checks it
against every rollback floor recorded since installation, takes another snapshot,
and starts the previous image by its immutable digest. It pins that image in `.env`
as `IMAGE:vX.Y.Z@DIGEST`, the name and digest it was pulled with, so the next start
can pull it again if the image was removed. Keep that image locally.
This also works when the app is stopped or restarting: its snapshot runs in a
separate container, and the same floor check applies before anything changes.
The history records the attempt and outcome; the health page records a successful
rollback as a version change with its source and destination versions.

If an interrupted nightly patch left its marker, `--rollback` first starts the pinned image and
reports that patch's recovery; run `--rollback` again to request a separate rollback. A failed
snapshot leaves an app that was already stopped or restarting stopped. If the previous image was
removed, the updater pulls its saved registry pin and verifies the image ID and version before
stopping the app. An image with no saved registry pin must be pulled by the owner first.

Running it again goes back one more version, as far as the floor allows, and never
forward to the version you just left. After an automatic or manual update it goes back at most
two versions, since older images are removed. To go forward again, update to that release.

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
  no trace in the floor. Fix the cause and update again. On a retry after a migrated
  failure the previous version stays stopped, because the earlier attempt already
  changed the database.
* **The database changed.** The previous version stays stopped. Retry the failed
  release with `sudo ./update.sh IMAGE`, or choose a newer compatible signed release;
  both work with the app stopped or restarting. The updater still verifies the
  signature, digest and floor. To go back, [restore](restoring.md#when-rollback-is-refused)
  the pre-upgrade snapshot named beside that option. The floor stays recorded, even
  though startup failed, and older releases stay refused.
* **The database can't be read.** The previous version stays stopped. Start PostgreSQL
  and run `update.sh` again, which also finishes an update that was killed part way.

A newer compatible signed release is one newer than the failed release whose rollback
floor is at or below the failed release, such as a patch of it or the next minor.

Keep the failed release's image locally. Forward recovery takes its next snapshot
with that compatible image's maintenance command, without starting its server or
running migrations before the backup. These retry snapshots use manual-backup retention,
so repeated retries cannot displace the original snapshot from the two pre-upgrade slots.
`.schema-recovery` records the failed release and the snapshot from before the first
migration until an update succeeds. A later failed migration updates the recovery release
while keeping that original snapshot. Failure messages, rollback refusals and the schema
guard keep naming that restore point, including after recovery succeeds and clears the
record. While the record exists, a rollback refusal also names the retry, which keeps
the data written since that snapshot. A retry that changes nothing preserves that record and the existing floor,
so it can be tried again. Do not remove the record
or `schema-compatibility.yaml` to force an older image to start.

Every manual release update records the migrations before starting the target,
including updates within the compatibility window. If a failed attempt changed
nothing, it closes as `abandoned` and contributes no rollback floor.

### After the update

* Open **System health** and check the running version, the last backup and that
  nothing is failing.
* Sign in as staff and as a member to confirm the admin and portal load.
* Keep local builds while you need `--rollback`: they have no registry pin to pull again.
  Registry images with a saved pin can be pulled again automatically if removed.
  Forward recovery keeps the failed release's compatible image for snapshots; it does not need
  the obsolete pinned image that can no longer run on the migrated database.
