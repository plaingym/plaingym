<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Update by hand

Use this page for a minor or major release (the "Update available" banner), for a patch
that didn't [install itself](updating.md), and to go back to the version you ran before.
It takes about 10 minutes, and the gym is unavailable for part of that time.

You run these commands on the server over SSH ([how to log in](install.md#3-log-in-to-the-server)).

## Before you update

1. **Check backups.** The updater takes a backup first and refuses to go on without one.
   The admin's **System health** page should show a recent successful backup; if not, set
   backups up in **Settings → Email, payments and backups**.
2. **Keep your backup private key and a copy of `/opt/plaingym/.env`** somewhere off the
   server. If an update goes wrong beyond repair, they are what a [restore](restoring.md)
   needs.
3. **Choose a quiet time.** The app is stopped while the backup runs and the new version
   starts.
4. **Note the version you run now.** The **System health** page shows it. Keep its image on
   the server until you are sure of the update: it is what a rollback goes back to.
5. **Read the release's notes** on the [releases page](https://github.com/plaingym/plaingym/releases).
   A release whose "Upgrade notes" name manual steps needs them done as well.

## Update

On the server, with the version you are updating to in place of `vX.Y.Z`:

```sh
cd /opt/plaingym
sudo ./update.sh ghcr.io/plaingym/app:vX.Y.Z
```

The argument is an explicit version tag, or a `sha256` digest, for your server's CPU.
`latest` is refused. The script:

1. checks the release's signature and pulls the new image while the app keeps running;
   if the release's rollback floor is above your version, it says so first
   ([what that means](update-reference.md#updating-across-a-rollback-floor));
2. stops the app and takes a pre-upgrade backup, encrypted to your backup key;
3. starts the new image, which applies its database migrations before it reports healthy;
4. installs the release's updated host scripts ([details](update-reference.md#host-files));
5. records the new image in `.env` only once the new version is healthy.

If you ask for the image you already run, it prints "Already on the requested image." and
does nothing else. A forked install sets `RELEASE_REPOSITORY` first
([install reference](install-reference.md#behind-a-proxy-or-a-fork)).

## After the update

* Open **System health** and check the running version, the last backup and that nothing is
  failing.
* Sign in as staff and as a member to confirm the admin and the portal load.
* Keep the previous image while you may need to roll back.

## If it stops

The updater says what happened. Most stops change nothing, and the old version keeps
running or is restarted; the exception is a failed update that already changed the
database (last row), which leaves the app stopped.

| What it says | What happened | What to do |
| :--- | :--- | :--- |
| "Backups are not set up: set them up in Settings → Email, payments and backups, then run the update again" | Nothing was changed; the current version was restarted. | Set up backups, run the command again. |
| "The pre-upgrade snapshot failed (reason above). Nothing was changed; the current version is restarting." | The backup failed (bucket unreachable, credentials changed). The line above says why. | Check the bucket and its keys under **Settings → Email, payments and backups**, and `sudo docker compose logs app`; run again. |
| "Update failed; restarting the previous image." | The new version didn't start or didn't pass its health check. | Unless the next line says the failed update changed the database (last row), the old version is back. Read `sudo docker compose logs app` for the reason before trying again. |
| "An update or key rotation is running." | An update or a key rotation is in progress (it takes a lock). | Wait for it to finish, then run the command again. |
| "The app must be running before an update." | The app is stopped. | Read `sudo docker compose logs app`. If the current release will not start, `sudo ./update.sh --rollback` (below). |
| Anything about a rollback floor, "Update failed; the previous version stays stopped.", "The failed update changed the database", "Recovery requires …" or "The recovery image is missing or incompatible" | The update changed the database and then failed. | Follow [the rollback floor section](update-reference.md#updating-across-a-rollback-floor): retry the same release, or update to a newer compatible one, or [restore](restore-reference.md#when-rollback-is-refused) the backup the message names. |

## Roll back to the previous version

If the new version runs badly, go back:

```sh
cd /opt/plaingym
sudo ./update.sh --rollback
```

The updater picks the previous successful version, takes another backup, and starts that
image. It also works when the app is stopped or restarting. Running it again goes back one
more version; after an update it can go back at most two versions, since older images are
removed. To go forward again, update to that release.

If the previous version is older than the release's **rollback floor** (it can't run on the
database any more), the command changes nothing and names the pre-upgrade backup to
[restore](restore-reference.md#when-rollback-is-refused). A restore is also what you need
when the data itself is damaged. [versioning.md](versioning.md) explains the compatibility
window.

After a rollback the nightly update skips the release you left; a newer patch installs by
itself.
