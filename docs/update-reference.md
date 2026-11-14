<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Updating reference

The operator detail behind [What happens each night](updating.md) and
[Update by hand](update-by-hand.md): how the updater treats the host's files, the signing
key, key rotation, rollback floors and forward recovery, and which images it keeps. The
updater's own mechanics (its lock, state files and exit codes) are in
[`deploy/README.md`](../deploy/README.md#updates-and-recovery); the version rules are in
[versioning.md](versioning.md).

## Banner rules

A transient download, pull, backup or app-check failure raises the "Patch release not
installed" banner only after two consecutive skipped attempts. A new install gets 50 hours
from its first health check before a missing nightly timer raises the banner, including on a
hand-installed Compose deployment. An invalid `RELEASE_REPOSITORY` raises a warning headed
"Updates can't install": patches cannot install until it is a valid `owner/name` and the app
is restarted. Neither path segment may consist only of dots. A failed check for an older
patch raises nothing once a newer one is out, because the next nightly check tries the
newest.

## Notices

With SMTP configured, each owner receives one notice per rolled-back or failed attempt;
replaying a report doesn't send the same notice again. While the app is down no email can go
out: if an update and its rollback both fail, you hear about it once the app runs again, in
a notice that says when the site went down and when the hourly check started the previous
version again. An SMTP refusal doesn't delay later results on the health tile. The host keeps
refused notices separately and retries each on its next run, with the same per-owner
delivery key. An unsent failed-rollback notice is replaced by the recovery notice for that
outage. Accepted or uncertain sends are never repeated. Other notice errors from database,
connection, owner or settings lookups stay queued for the next run. Unreadable SMTP settings
and rendering errors are logged in the updater journal without retrying the notice. The
timer asks the app for the gym's timezone every hour, so after you change it the next night
in the new timezone counts.

## Images kept for rollback

After a successful automatic or manual update, the updater keeps the current image and the
two before it, so `--rollback` can go back up to two versions. It removes the images of older
versions (the installer's included, once it is three updates back) and the images it pulled
for releases that were rolled back. It never forces a removal or runs a global image prune;
images pulled by other tools are left alone. Local builds have no registry pin to pull again,
so keep them while you need `--rollback`; a registry image with a saved pin is pulled again
automatically if it was removed.

## Internal v0.x builds

The v0.1 through v0.4 milestones were internal commits, without release tags. A database from
one of those builds migrates forward when the current image starts; it doesn't need each
intermediate image. Preserve the installation's encryption key and uploads alongside its
database backup. Development versions are not offered automatic updates, so choose an explicit
image and follow the manual update steps. Returning to an internal build requires restoring its
complete pre-upgrade backup; the release rollback promise doesn't cover those builds. The
[historical upgrade suite](../e2e/upgrade/README.md) records the four gate commits and checks
their data, encrypted settings and application pages after a restore and migration to the
current schema.

## Host files

The updater refreshes `update.sh`, `lib.sh`, `rotate-key.sh`, `restore.sh` and both systemd
units with the release. It checks the signed manifest, the deployment archive and every
host-file digest before stopping the app. Once the app is healthy, it replaces each file by an
atomic rename and reloads systemd. The running updater finishes from the file it opened; the
next run uses the new one. The updater preserves `.env`, Compose, Caddy and PostgreSQL
configuration. A release changing those configuration files still names the required manual
steps in its upgrade notes. Signed releases without host-file digests update only the image.

Previous copies stay in `.host-history/`, associated with the image they ran with. A failed
replacement restores them before restarting the previous image. After a power loss, the next
invocation recovers `.host-update` before doing another update. Both the updater and
`rotate-key.sh` take the update lock and recover before loading the shared library, then
restart from their restored script. If systemd can't reload, the restored files and journal
stay for another try; a failed update still rolls the image back and records its result. A
manual update also settles any interrupted nightly patch first; run the manual update again
afterwards. `--rollback` restores the previous host files and units when a saved copy exists.
Successful updates remove saved host generations once their image is gone from the host and
has no saved registry pin that `--rollback` could pull again. Don't remove these directories
while an update or recovery is unfinished.

## The release signing key

The signing key must remain the currently trusted key. A release can't rotate it
automatically, and rolling back never restores an older signing key. If a signing key must
change, verify the replacement through the maintainer's trusted release instructions and
install it explicitly before updating. This is separate from rotating the installation's
encryption key with `rotate-key.sh`.

An image with a release version label requires its signed release manifest and signature,
even when it came from a mirror or a local build; there is no verification override. For a
fork, set `RELEASE_REPOSITORY=owner/repository` in the install's `.env` to the GitHub
repository publishing its signed releases, and install its release signing public key. A
network outage, missing release assets, an invalid signature or a digest mismatch stops the
update while the current app keeps running: check the reported repository and release,
restore network access or publish the correct signed assets, then retry.

## Key rotation and updates

While `/opt/plaingym/.rotate-key.inflight` exists, a manual update fails and the nightly
update skips, both saying that key rotation is unfinished. Run `sudo ./rotate-key.sh` again to
finish the rotation before updating; keep the marker and both keys until it succeeds.

* Rotation temporarily revokes the app's database CONNECT privilege and waits up to 30
  seconds for existing sessions to close, refusing if any remain. It never terminates
  sessions.
* A partial rewrite (maintenance exit code 2) or any uncertain failure keeps the app stopped;
  rerun with the same keys in the marker. Rerunning also restores CONNECT after a crash,
  including one after `.env` was already switched.
* Only a definite preflight refusal (exit 3), with no earlier attempt that may have committed
  pages, restores CONNECT and restarts the app with its old key. Repeated clean refusals
  restart it each time so settings can be corrected in the admin; an exit-3 refusal after a
  partial or uncertain attempt keeps the fence and app stopped.
* A refusal that finds a value neither key opens and none under the new key (exit 4) proves
  no attempt committed anything, so it restarts the app too.

The marker records this distinction durably before each attempt. The one-off command bypasses
the image's normal entrypoint so a retained fence can't block the maintenance connection
needed to finish the rotation. When to rotate, and the full steps, are in
[self-hosting.md](self-hosting.md#rotating-the-encryption-key) and
[`deploy/README.md`](../deploy/README.md#rotating-the-encryption-key).

## Rollback details

`--rollback` selects the previous successful version from `version-history.tsv`, checks it
against every rollback floor recorded since installation, takes another snapshot, and starts
the previous image by its immutable digest. It pins that image in `.env` as
`IMAGE:vX.Y.Z@DIGEST`, the name and digest it was pulled with, so the next start can pull it
again if the image was removed. Its snapshot runs in a separate container, so it works with
the app stopped or restarting, and the same floor check applies before anything changes. The
history records the attempt and outcome; the health page records a successful rollback as a
version change with its source and destination versions.

If an interrupted nightly patch left its marker, `--rollback` first starts the pinned image
and reports that patch's recovery; run `--rollback` again to request a separate rollback. A
failed snapshot leaves an app that was already stopped or restarting stopped. If the previous
image was removed, the updater pulls its saved registry pin and verifies the image ID and
version before stopping the app. An image with no saved registry pin must be pulled by the
owner first. Running it again never goes forward to the version you just left.

The signed release manifest declares the oldest compatible code (the **rollback floor**). If
the previous version is below it, the command changes no app, image pin or history and names
the pre-upgrade snapshot to [restore](restore-reference.md#when-rollback-is-refused).

Keep `schema-compatibility.yaml` with this installation's database. The updater passes its
checked floor to both startup and migration; code below that floor refuses to start. Don't
remove it to bypass a rollback refusal.

## Updating across a rollback floor

A release's floor can be above your version: a major that breaks compatibility, or a skipped
minor such as 1.2 to 1.4. The update prints that first. Once that release has migrated the
database, your version can't run on it, so `--rollback` refuses and the way back is the
pre-upgrade snapshot.

If such an update fails, the updater stops the new version and checks the database:

* **Nothing was migrated.** The previous version starts again and the attempt leaves no trace
  in the floor. Fix the cause and update again. On a retry after a migrated failure the
  previous version stays stopped, because the earlier attempt already changed the database.
* **The database changed.** The previous version stays stopped. Retry the failed release with
  `sudo ./update.sh IMAGE`, or choose a newer compatible signed release; both work with the app
  stopped or restarting. The updater still verifies the signature, digest and floor. To go
  back, [restore](restore-reference.md#when-rollback-is-refused) the pre-upgrade snapshot
  named beside that option. The floor stays recorded, even though startup failed, and older
  releases stay refused.
* **The database can't be read.** The previous version stays stopped. Start PostgreSQL and run
  `update.sh` again, which also finishes an update that was killed part way.

A newer compatible signed release is one newer than the failed release whose rollback floor is
at or below the failed release, such as a patch of it or the next minor.

### The messages

| What it says | What to do |
| :--- | :--- |
| "Update failed; the previous version stays stopped." | A retry after a migrated update failed. The previous version can't run on the database, so nothing restarts. Read `sudo docker compose logs app`, then follow the next message: retry, or update to a newer compatible signed release. |
| "The failed update changed the database, and … can't run on it." | An update across a floor migrated the database, then failed. Retry the same release with `sudo ./update.sh IMAGE`, or update to a newer compatible signed release, even while the app is stopped or restarting. To go back, [restore](restore-reference.md#when-rollback-is-refused) the snapshot the message names. |
| "Recovery requires … or a newer compatible signed release." or "Recovery requires a release whose rollback floor covers …" | The requested release can't recover this install. Nothing was changed. Use the failed release again or a newer compatible signed release, or restore the snapshot. |
| "The recovery image is missing or incompatible." | The failed release's image is no longer on the server, so forward recovery can't take its snapshot. The app stays stopped. Pull that release's image again and retry, or restore the pre-upgrade snapshot. |
| "The app must be running before an update." and a migrated update is recorded | Retry its release or a newer compatible signed release, as above. |

### Forward recovery

Keep the failed release's image locally. Forward recovery takes its next snapshot with that
compatible image's maintenance command, without starting its server or running migrations
before the backup. These retry snapshots use manual-backup retention, so repeated retries
can't displace the original snapshot from the two pre-upgrade slots. `.schema-recovery`
records the failed release and the snapshot from before the first migration until an update
succeeds. A later failed migration updates the recovery release while keeping that original
snapshot. Failure messages, rollback refusals and the schema guard keep naming that restore
point, including after recovery succeeds and clears the record. While the record exists, a
rollback refusal also names the retry, which keeps the data written since that snapshot. A
retry that changes nothing preserves that record and the existing floor, so it can be tried
again. Don't remove the record or `schema-compatibility.yaml` to force an older image to
start. It doesn't need the obsolete pinned image that can no longer run on the migrated
database.

Every manual release update records the migrations before starting the target, including
updates within the compatibility window. If a failed attempt changed nothing, it closes as
`abandoned` and contributes no rollback floor.
