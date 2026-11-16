<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Restore after losing a server

Use this page to bring the gym back from a backup: after the server is lost or broken, to
move to a new server, or to undo an update that can't be rolled back. A restore always goes
onto a **fresh install**, and it replaces that install's data with the backup's. How backups
work (hourly snapshots; 24 hourly, 7 nightly and 4 weekly are kept; encrypted) is in
[self-hosting.md](self-hosting.md#backups).

Plan on about an hour, mostly the install.

**Use a trusted snapshot and backup bucket.** A restore executes the snapshot's SQL
as `maintenance`; successful decryption and integrity checks do not make that SQL
safe. After loading and migrating the database, the catalog check refuses extra
schemas usable by `app` or `maintenance` (only `public`, `drizzle`, `pg_catalog`,
`information_schema` and `pg_toast*` are allowed), any persistent settings for the
current database, and global role settings for `app`, `maintenance` or all roles.
Bootstrap sets none of these defaults. Every database pool the server opens uses
`search_path=public`, including maintenance and authentication connections. The `app`
role must have no `USAGE` or `CREATE` on `drizzle`. Views and functions in `drizzle` receive the
same isolation checks as those in `public`. A failed check keeps the restore gated
before secrets or uploads are activated. These checks limit known isolation risks;
they do not sandbox arbitrary snapshot SQL or replace trust in the backup source.

Before each database load, restore drops `public`, `drizzle`, and extra schemas
owned by `maintenance`, and resets all database-wide defaults and `maintenance`'s
global and database-specific role defaults. Both the reset connection and
`pg_restore` override read-only and timeout defaults so those leftovers cannot
block recovery. Dropping a schema with `CASCADE` also drops objects in other
schemas that depend on it, even when another role owns them. Schemas owned by
other roles are not themselves dropped, and other roles' defaults remain in
place; the catalog check still refuses unsafe leftovers.

## Recovering from a catalog refusal

The catalog error names each stored setting, its database and role, or the extra
schema. Setting values are omitted. If the leftover is another role's default or another
role's schema, a PostgreSQL administrator must repair it before startup or restore
can pass. On the affected install, stop the app and open the database console:

```sh
cd /opt/plaingym
sudo docker compose stop app
sudo docker compose exec postgres sh -c 'psql -U postgres -d "$POSTGRES_DB"'
```

Reset only the scope named by the error. For example, for a setting on role `app`
in database `plaingym`, run `ALTER ROLE app IN DATABASE plaingym RESET ALL;`.
Replace those names with the reported database and role. For a global role default
(reported as `all databases`), use `ALTER ROLE app RESET ALL;`; for global defaults
on `all roles`, use `ALTER ROLE ALL RESET ALL;`. A database-wide default (reported
as `database plaingym, role all roles`) is cleared by the next restore; to start the
app without one, use `ALTER DATABASE plaingym RESET ALL;`.
`maintenance`'s own role defaults are also cleared before the next database load.

For an extra schema, inspect its owner with `SELECT nspname,
pg_get_userbyid(nspowner) FROM pg_namespace;`. Preserve any data and dependencies
you need before the administrator removes the unwanted schema. Restore does not
automatically drop schemas it does not own.

Exit with `\q`, then start the app with `sudo docker compose up -d`. A staged
restore resumes the same verified snapshot. If that snapshot recreates the refused
objects or defaults, restore a trusted snapshot onto another fresh install instead;
keep the failed install's journal and staging for investigation. A new snapshot
cannot replace an active staged restore ([interrupted restores](restore-reference.md#if-a-restore-is-interrupted)).

## Before you start

You need four things. If you are moving on purpose, capture the latest changes first (below).

1. **The backup private key.** It was shown once when backups were set up: a block of text
   beginning `AGE-SECRET-KEY-`, or the file you downloaded. Without it nobody can open the
   backups. If you replaced the key since, you need the key that matches the snapshot.
2. **The storage bucket's details:** the bucket name, the service's address (the endpoint,
   for services other than AWS), the region, and an access key ID and secret that can read it.
   Your storage provider's dashboard shows them.
3. **A snapshot ID.** In the bucket, each snapshot is a folder under `snapshots/`; the folder's
   name is the ID. Choose the newest one from before the problem. A snapshot taken before an
   update is in the same place.
4. **A fresh server,** installed with the [install page](install.md) **up to the point where it
   prints the setup link.** Use the same hostname as before, or a new one. **Don't go through
   the wizard first:** setup closes once an owner exists.

**Moving on purpose?** Owners and admins can choose **Back up now** on **System health → Last
backup** (owners can also use it in **Settings → Integrations**) and wait for
the completed snapshot's time and ID. Without the admin, run
`sudo docker compose exec -T app node /app/maintenance.mjs snapshot` in `/opt/plaingym`; it
prints the new snapshot ID.

**Is the old server still running?** Shut it down as soon as the restore is done, and always
before you turn billing or member emails on. Two installs would charge the same members, send
them the same emails, and both take and prune backups in the same bucket.

## Restore from the setup wizard

1. Open the setup link (`https://gym.example.org/setup#token=…`). If you lost it, log in to
   the server over SSH ([how](install.md#3-log-in-to-the-server)) and print it:

   ```sh
   cd /opt/plaingym
   sudo docker compose exec -T app gym-app setup-link
   ```
2. On the first step, choose **Restore a backup**.
3. Enter the storage endpoint, region, bucket and access key (ID and secret), the snapshot
   (its ID, or the `snapshots/ID/` prefix) and the backup private key, and start the restore.
   Keep the page open: it shows progress.
4. When it reports "Backup restored", sign in as the owner you had before.

The restore checks the backup, loads the database and the uploaded files, and re-encrypts the
gym's stored secrets (Stripe key, email password, backup settings) for the new install. The
wizard is skipped afterwards, because the restored gym is already set up. A backup taken
before an encryption-key rotation restores the same way.

If the wizard says the restore failed, check the bucket details, snapshot ID and key against
the [restore errors](restore-reference.md#restore-errors), then start it again. An interrupted
restore finishes by itself when the app restarts ([details](restore-reference.md#if-a-restore-is-interrupted)).

## Restore from the command line

Use this when the wizard can't be reached. Run it on the fresh install, before anyone has
completed setup. You work on the server over SSH.

1. **Write the bucket details to a file.** Files on the server are edited with `nano`, a simple
   text editor. Create the file and open it:

   ```sh
   cd /opt/plaingym
   sudo nano restore.json
   ```

   Paste this, replace the values, and keep the quotes and commas:

   ```json
   {
     "bucket": "my-gym-backups",
     "endpoint": "https://example.r2.cloudflarestorage.com",
     "region": "auto",
     "accessKeyId": "…",
     "secretAccessKey": "…"
   }
   ```

   Save with **Ctrl+O** then **Enter**, and leave with **Ctrl+X**. `endpoint` is the storage
   service's address without the bucket name; leave the line out for AWS S3. `region` is
   optional and defaults to `auto`.
2. **Save the backup private key** the same way, as the file `backup-key.txt` (`sudo nano
   backup-key.txt`, paste the whole key, save).
3. **Check the JSON.** `python3 -m json.tool restore.json` prints the file back when it is
   valid and names the line when it isn't. Fix it with `sudo nano restore.json` if needed.
4. **Make both files private:** `sudo chmod 600 restore.json backup-key.txt`.
5. **Run the restore** with your snapshot ID:

   ```sh
   sudo ./restore.sh SNAPSHOT_ID restore.json backup-key.txt
   ```

   It copies both files into the app's private storage for the restore and removes those
   copies afterwards, whether the restore works or not. On success it says that billing and
   member emails remain paused and that pruning is held. Member texts are also off. On failure it prints
   `Restore failed: ` and a reason; look the reason up in the
   [restore errors](restore-reference.md#restore-errors), fix what it names and run the
   command again. If it also says a verified restore can be resumed, a restore is staged and a
   new one is refused: finish it as in
   [If a restore is interrupted](restore-reference.md#if-a-restore-is-interrupted).
6. **Delete your copies:** `sudo rm restore.json backup-key.txt`. Keep your original backup
   private key in safe storage.

## What to check afterwards

1. **Billing, member emails and member texts are off.** All three stay off until you turn them on yourself in
   **Settings → Go live**, so a restored copy doesn't charge members or send duplicate member
   emails or texts while the old server still runs.
2. **Reconcile payments.** The app compares its payment records with Stripe. Open **Settings →
   Go live**: the checklist's *Payment reconciliation* item must be clear. If it shows
   unresolved items, correct them and use **Check restored payments again**. Then turn billing
   back on ([going-live.md](going-live.md)). The detail, including a gym with no Stripe key, is
   in [payment reconciliation](restore-reference.md#payment-reconciliation).
   If you switch Stripe modes after the check, billing pauses. Go live and Payments
   name the mode the earlier check read and ask you to check again in the saved
   mode before turning billing back on; a clear test-mode check cannot clear live payments.
3. **Stripe webhooks.** In **Settings → Integrations**, check that **Payments**
   shows the webhook endpoint as registered. If the hostname changed, the endpoint Stripe knows
   still points at the old address: paste the Stripe key again, which registers the endpoint at
   the new address (the same key and mode are accepted without clearing anything).
4. **Backups.** Check that **System health** shows a new successful backup. New snapshots
   continue after a restore, but the bucket's old snapshots aren't pruned until the owner
   uses **Confirm the old server is gone** in Settings or on the Last backup tile and confirms
   **Resume backup pruning**. Until then the bucket grows, and once it reaches the retention
   budget new snapshots fail. If the backup key was lost, or you want a new one, replace it
   under **Settings → Integrations**; pruning stays held until the owner
   confirms the old server is gone.
5. **Only one install should run the gym.** Shut the old server down now (see above).

## When rollback is refused

`update.sh --rollback` prints a snapshot ID when the previous version is older than the rollback
floor, and so does a failed update that already migrated the database. Restore that snapshot
with this page, using the private backup key: [what to do and why](restore-reference.md#when-rollback-is-refused).
