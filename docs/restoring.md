<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Restore guide

How to bring a gym back from a backup: after losing a server, moving to a new one,
or undoing a bad update. A restore always goes onto a **fresh install**; it replaces
that install's data with the snapshot's. How backups work (hourly snapshots,
retention, encryption) is in [self-hosting.md](self-hosting.md#backups).

## What you need

* **The backup private key** shown once when backups were set up (a block of text
  beginning `AGE-SECRET-KEY-`, or the file you downloaded). Without it no one can
  open the snapshots.
* **The bucket details**: bucket name, endpoint (for non-AWS services), region, and an
  access key that can read it.
* **A snapshot ID.** In the bucket, each snapshot is a folder under `snapshots/`; its
  name is the ID. Choose the newest one that predates the problem. A pre-upgrade
  snapshot from an update is in the same place.
* **A fresh server**, installed with the [install guide](install.md) up to the point
  where it prints the setup link. Use the same hostname as before, or a new one.
  Don't go through the wizard first: setup closes once an owner exists.

## Restore from the setup wizard

1. Open the setup link (`https://gym.example.org/setup#token=…`). If you lost it, print
   it on the server:

   ```sh
   cd /opt/plaingym
   sudo docker compose exec -T app gym-app setup-link
   ```
2. On the first step, choose **Restore a backup**.
3. Enter the storage endpoint, region, bucket and access key (ID and secret), the
   snapshot (its ID, or the `snapshots/ID/` prefix) and the backup private key, and
   start the restore. Keep the page open: it shows progress.
4. When it reports "Backup restored", sign in as the owner you had before.

The restore verifies the snapshot, loads the database and the uploaded files, and
re-encrypts the gym's stored secrets for the new install (Stripe key, email
password, backup settings), with the `APP_ENCRYPTION_KEY` the backup carries as
the old key. A backup taken before a key rotation
([self-hosting.md](self-hosting.md#rotating-the-encryption-key)) restores the
same way. The wizard is skipped, because the restored gym is already set up.

## What to check afterwards

1. **Billing is paused.** It stays off until you turn it on yourself, so no one is
   charged by a restored copy by surprise. **Member emails** keep the setting they had
   in the backup: if the old server is still running, turn them off on **Settings →
   Go live** until it is shut down, so members don't get two copies of each email.
2. **Reconcile payments.** The app compares its payment records with Stripe. Open
   **Settings → Go live**; the checklist's *Payment reconciliation* item must be
   clear. If it shows unresolved items, correct them and use **Check restored
   payments again**. Then turn billing back on ([going-live.md](going-live.md)).
3. **Stripe webhooks.** Open **Settings → Email, payments and backups** and check that
   **Payments** shows the webhook endpoint as registered. If the hostname changed, the
   endpoint Stripe knows still points at the old address: paste the Stripe key
   again, which registers the endpoint at the new address (the same key and mode
   are accepted without clearing anything).
4. **Backups.** Check that the **System health** page shows a new successful backup. If the
   backup key was lost or you want a new one, replace it under **Settings → Email,
   payments and backups**.
5. **Only one install should run the gym.** If the old server is still up, shut it
   down as soon as the restore is done, and always before you turn billing on.
   Otherwise two installs charge the same members, send them the same emails, and
   both take and prune snapshots in the same backup bucket.

## Restore from the command line

Use this when the wizard can't be reached, or to script a restore. Run it on the
fresh install, before anyone has completed setup.

1. Create a private JSON file with the bucket details and the path of a file holding
   the private key:

   ```json
   {
     "bucket": "my-gym-backups",
     "endpoint": "https://example.r2.cloudflarestorage.com",
     "region": "auto",
     "accessKeyId": "…",
     "secretAccessKey": "…",
     "identityFile": "/var/lib/plaingym/backup-key.txt"
   }
   ```

   `endpoint` is optional (leave it out for AWS S3), `region` defaults to `auto`, and
   the key file holds the private key as downloaded.
2. Put both files inside the app container, on its data volume (`/var/lib/plaingym`).
   A file under `/opt/plaingym` on the server is not visible there. Writing them
   through the container makes them belong to the app's user and readable by no one
   else:

   ```sh
   cd /opt/plaingym
   sudo docker compose exec -T app sh -c 'umask 077; cat > /var/lib/plaingym/restore.json' < restore.json
   sudo docker compose exec -T app sh -c 'umask 077; cat > /var/lib/plaingym/backup-key.txt' < backup-key.txt
   ```
3. Run:

   ```sh
   sudo docker compose exec -T app gym-app restore SNAPSHOT_ID --config /var/lib/plaingym/restore.json
   ```

   It prints "Restore complete; billing remains paused" when it succeeds, and
   "Restore failed; verified restores can be resumed with the maintenance CLI" for any
   failure, without the cause. Check the file, the bucket details, the snapshot ID
   and the key against the list above, then run it again.
4. Delete both files, from the container and from wherever you wrote them:

   ```sh
   sudo docker compose exec -T app rm /var/lib/plaingym/restore.json /var/lib/plaingym/backup-key.txt
   ```

Details of the file, the snapshot format and the lock are in
`apps/server/src/areas/health/backups.protocol.md`.

## If a restore is interrupted

A verified restore resumes by itself when the app restarts (`sudo docker compose up -d`):
the container's entrypoint resumes it before migrations or any request. If the wizard
says the restore failed, check the bucket, credentials, snapshot ID and key against the
list above, then start it again.
