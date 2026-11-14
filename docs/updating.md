<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# What happens each night

Releases are numbered `vX.Y.Z`. A **patch release** (only Z changes: `v1.2.3` to
`v1.2.4`) holds fixes and never changes the database. An install made with the installer
takes patch releases by itself each night, and you don't have to do anything. **Minor and
major releases** (`v1.2` to `v1.3`, or `v2`) wait for you: owners and admins see an
"Update available" banner, and you [update by hand](update-by-hand.md).

## The nightly update

Every hour, the server's update timer (`plaingym-update.timer`) wakes up. Between 02:00
and 05:00 in the gym's timezone it acts once, and the other hours it stops at once. It
looks for a newer patch release of the version you run (from 1.2.3 it takes 1.2.4, never
1.3.0). If there is one, it:

1. checks the release's signature, so it only installs what the project published;
2. takes a backup;
3. installs the new version and checks that it stays healthy for a minute;
4. goes back to the previous version if it doesn't.

Owners switch it off, or on again, in **Settings → Updates**; it is on by default. It does
nothing, and tells you why, until backups are set up
(**Settings → Email, payments and backups**).

If a release fails (it is rolled back, or the update and its rollback both fail), the
updater tries it once more the next night. If it fails again, automatic updates wait for a
newer patch release instead of trying every night, and the tile and the owner notice say
so. With email set up, each owner gets one notice for each rolled-back or failed attempt.

To run the check now rather than tonight, for example after setting up backups, log in to
the server over SSH ([how](install.md#3-log-in-to-the-server)) and run:

```sh
sudo /opt/plaingym/update.sh --patch --now
```

## Where to see the result

The admin's **System health** page has an **Automatic updates** tile. It shows the last
night's result (up to date, updated, rolled back, or skipped and why) and, after later
checks, the last update or the last attempt that failed, with its date and time in the
gym's timezone. An error that is no longer new keeps its cause and adds the time of the last
check. After a [restore](restoring.md) it shows only this server's checks, not the old
server's.

| The tile says | What to do |
| :--- | :--- |
| Backups aren't set up | Set them up in **Settings → Email, payments and backups**; the next night's check installs the release. |
| The server has no release signing key | On the server, run the installer again from the current deployment files with `--image` set to the running image, or copy `release-signing.pem` into `/opt/plaingym`. |
| The list of releases, the manifest or the image couldn't be downloaded, or the backup before the update failed | Nothing was changed; the next nightly check tries again. Check the server's network, or the bucket under **Settings → Email, payments and backups**. |
| The signature didn't verify, the image doesn't match the manifest, or the patch changes the database | Nothing was installed, on purpose. Update by hand once a fixed release is out. Don't install that release yourself. |
| Version X was rolled back | The new version didn't start or failed its health check, and the previous one runs again. On the server, `cd /opt/plaingym` and `sudo docker compose logs app` show why. |
| The update failed and starting the previous version failed too | `sudo docker compose ps` shows the containers. The updater tries to start the previous version again each hour until it runs. |
| The update and its rollback failed, so the site was down from … until … | The hourly check started the previous version again. `sudo docker compose logs app` says why the new version and the restart failed. |
| Version X failed twice, so automatic updates will wait for a newer patch release | Read `sudo docker compose logs app`. To try that release again, run `sudo /opt/plaingym/update.sh --patch --now`. A newer patch installs by itself. |
| No nightly update check since … | Check the timer: `systemctl status plaingym-update.timer`. The updater's log is `journalctl -u plaingym-update`. |

An install set up by hand with Docker Compose has no timer until you
[add it](install-reference.md#adding-the-update-timer).

## When a patch doesn't install by itself

A newer patch release raises no banner while the nightly update is expected to install it.
When it won't (automatic updates are off, no nightly check has run for two days, or the last
check for that release was held, rolled back or failed), a banner appears and says why.

* Automatic updates off, or the timer stopped: turn them on or fix the timer, or install
  the release by hand.
* The updater refused it on purpose (its signature, its image or a database change): don't
  install it by hand. Update by hand once a fixed release is out.
* Anything else: do what the banner says.

The rules behind the banner, how many images are kept for rollback and the files the updater
keeps are on the [updating reference](update-reference.md). An install of a fork sets
`RELEASE_REPOSITORY` and installs that fork's signing key: see
[the release signing key](update-reference.md#the-release-signing-key).

After a rollback, the nightly update skips the release you left, and any older patch of that
minor; the health page says why. A newer patch still installs by itself. To take the skipped
release anyway, [update to it by hand](update-by-hand.md).
