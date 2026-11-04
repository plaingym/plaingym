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

A newer patch release raises no banner, even when automatic updates are off; with
them off, install it by hand as below.

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
| "Update failed; restarting the previous image." | The new version didn't start or didn't pass its health check. | The updater restarted the previous image and left the old image in `.env`. Read `sudo docker compose logs app` for the reason before trying again. |
| "Another update is running." | An `update.sh` is already running (it takes a lock). | Wait for it to finish. |
| "The app must be running before an update." | The app container is stopped. | `sudo docker compose up -d`, then update. |

Releases change the database only by adding to it, and a column is dropped only a
release after the app stops using it, so the release just before the new one still
works against the migrated database. If the new version runs but misbehaves and you
need to go back, run `update.sh` with that release's tag. If you skipped releases
in the update (for example 1.0 to 1.2), going back to the version you ran before
isn't safe: [restore](restoring.md) the pre-upgrade backup the updater took instead.
Restore it too if the data itself is damaged.

### After the update

* Open **System health** and check the running version, the last backup and that
  nothing is failing.
* Sign in as staff and as a member to confirm the admin and portal load.
* Once you are sure of the update, remove the old image with
  `sudo docker image rm <old tag>` (`sudo docker image ls` lists them).
