<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Restore reference

The detail behind [Restore after losing a server](restoring.md): what a restore does with
keys and snapshots, how payment reconciliation behaves, what each command-line error means,
and what to do when a restore is interrupted or a rollback is refused. The snapshot format
and lock are in `apps/server/src/areas/health/backups.protocol.md`.

## Backup keys and snapshots

Settings and System health report the last restorable snapshot for the current backup key and
destination. After changing either, they report none under that key yet until a matching
snapshot succeeds. Keep older private keys to restore older snapshots; replacing a key doesn't
make those snapshots open with the new one. Older snapshots without recipient metadata remain
restorable with their original key, but don't establish the current-key health status.

**Back up now** queues one manual snapshot; a second request is refused until it finishes,
and requests during a restore or before backup setup are refused.

## When rollback is refused

`update.sh --rollback` prints the snapshot identifier when the previous image is below the
recorded rollback floor, and so does a failed update across a floor that had already migrated
the database. Find that pre-upgrade snapshot in the backup destination and
[restore it](restoring.md) using the private backup key. For a downgrade across that boundary,
restore into a fresh installation of the version that made the snapshot, with its own empty
database and volumes. Keep the stopped original installation until the restored gym has been
checked. Don't copy the newer installation's `schema-compatibility.yaml` into the restored
installation, or remove that file to run older code against the newer database. The source
installation's `version-history.tsv` records the version, digest, floor and snapshot for each
attempt. The floor rules are in the [updating reference](update-reference.md#updating-across-a-rollback-floor).

## Payment reconciliation

After a restore, the app compares its payment records with Stripe. **Settings → Go live**'s
*Payment reconciliation* item must be clear before billing turns on; if it shows unresolved
items, correct them and use **Check restored payments again**.

* If the gym has no Stripe key (it takes only cash or other manual payments), the check reads
  only the restored records: with no card payments in progress it is clear and the item reads
  *not applicable*. If the records still refer to Stripe payments, connect Stripe and check
  again.
* Once Stripe is connected, a check made without it no longer counts. Saving the Stripe
  settings pauses billing in the same transaction, even if you already turned it on after the
  earlier check. Go live labels that check's count as *Stored references* and says it ran
  without Stripe. The Payments section also explains the pause.
* The check records the Stripe mode it read: a test-mode check doesn't clear live payments, so
  saving Stripe settings in a different mode pauses billing the same way, while re-saving the
  checked mode keeps it on. Run **Check restored payments again** to compare with Stripe, then
  turn billing back on once it is clear.

## Restore errors

The restore command prints `Restore failed: ` and a reason. The reason names a configuration
field, a code or an error name, never a path, key, credential or field value. It then prints
"A verified restore can be resumed with the maintenance CLI" only if an unfinished restore is
staged.

| Reason | What to check |
| :--- | :--- |
| `Cannot read the restore configuration file (CODE)` | The path, and that the file is inside the container (`ENOENT` is a missing file, `EACCES` a file the app can't read). |
| `The restore configuration file is not valid JSON` | The file's syntax (`python3 -m json.tool restore.json`). |
| `The restore configuration file has invalid fields: NAMES` | The fields named: missing, empty or wrongly formed. A field the file has that the command doesn't know is counted (`(1 unrecognized field)`), not named; look for a misspelled name next to a missing one. |
| `SNAPSHOT is not a snapshot ID (a UUID)` | The ID you passed. |
| `The restore configuration names a different snapshot than SNAPSHOT` | The `snapshotId` field, if you set one. |
| `Cannot read the key file (CODE)` | `identityFile` in the configuration, and that the file is inside the container. |
| `The backup bucket answered with error CODE` | The bucket's error code (such as `AccessDenied`, or `HTTP` and a status): the access keys, region and endpoint. |
| `Cannot reach the backup bucket (CODE)` | The `endpoint` and the server's network connection; `ECONNREFUSED` and `ENOTFOUND` mean nothing answered at that address. |
| `Snapshot not found in the bucket` | The snapshot ID, and the `bucket` name: a bucket that doesn't exist reads the same as a snapshot that doesn't. |
| `The key doesn't open this snapshot` | That the key file is the private key for the backup key the snapshot was made with. |
| `The key file doesn't hold an age private key`, `The key file must hold exactly one age private key` | The key file's content. |
| `A snapshot object is missing from the bucket` | The snapshot was damaged or deleted in the bucket; try an earlier one. |
| `A verified restore is already staged; resume it first` | See [If a restore is interrupted](#if-a-restore-is-interrupted). |
| `Missing NAME` | The environment variable the app container needs. |
| `Restored gym receipt is missing` | The restored database's restore audit record. Keep the staged restore and investigate before retrying. |
| `Invalid current app key` | APP_ENCRYPTION_KEY must be the destination install's key, 64 hex characters. |
| `Restore staging must be outside uploads` | Place BACKUP_STAGING_DIR outside UPLOADS_DIR so replacing uploads can't remove staging. |
| `Restore staging and uploads must share a filesystem` | Place staging and directory uploads on the same mounted volume for atomic renames. |
| `Manifest belongs to another snapshot` | The snapshot's manifest doesn't match its ID. Use an intact snapshot. |
| `Manifest and authenticated references disagree` | The snapshot's manifest and reference list disagree. Use an intact snapshot. |
| `The restore journal is not in a format this version reads` | `restore-state.json` on the data volume is damaged or from another app version. Keep it, run the app version that started the restore, and investigate if that doesn't help. |
| `Restore journal does not match staged snapshot` | The staged manifest doesn't match the restore journal. Preserve both and investigate. |
| `Current install key changed during restore` | Restore the destination APP_ENCRYPTION_KEY used when this restore began before resuming. |
| `Upload storage changed during restore` | Restore the uploads storage configuration used when this restore began before resuming. |
| `Unexpected uploads directory during restore` | An uploads directory appeared during the switch. Preserve the current and staged trees and investigate. |
| `Restored uploads tree missing` | The staged and destination upload trees are missing. Preserve the journal and recover the staged files before resuming. |
| `MAINTENANCE_DATABASE_URL must name the maintenance database role` | The user in MAINTENANCE_DATABASE_URL: the maintenance commands (migrate, snapshot, restore, resume, rotate-key, restore-connect) connect only as `maintenance`. |
| `Usage: restore SNAPSHOT --config PRIVATE_JSON_FILE` | Supply the snapshot ID and --config followed by the private configuration filename. |
| `The snapshot's contents are not in a format this version reads` | Use a compatible snapshot and app version. Snapshot field names and values aren't printed. |
| `The snapshot is damaged; try an earlier one` | Snapshot metadata, authentication or checksums failed before activation. Nothing was restored; use an intact earlier snapshot. |
| `The staged restore failed; preserve the restore state and check the server before retrying resume` | A failure after activation, including damaged staged files, a database restore failure, or a disk error just after the restore journal was written. Keep the journal and staged files, investigate the server and storage, then retry `resume` once the cause is resolved. An earlier snapshot can't replace an active restore. |
| `The staged restore failed: the uploads bucket answered with error CODE; preserve the restore state, fix the uploads bucket, then retry resume` | An install that keeps uploads in S3: its uploads bucket (`UPLOADS_S3_*`, not the backup bucket) refused to take the restored files, with that error code (such as `AccessDenied`, or `HTTP` and a status). Fix its access keys or policy, then resume. |
| `The staged restore failed: cannot reach the uploads bucket (CODE); preserve the restore state, fix the uploads bucket, then retry resume` | The uploads bucket's endpoint didn't answer (`ECONNREFUSED`, `ENOTFOUND` or a timeout). Check `UPLOADS_S3_ENDPOINT` and the network, then resume. |
| `The restore activity lease is invalid; stop the app, delete the restore-activity folder on its data volume, then start the app` | A process lease file on the data volume is invalid or oversized. Each process keeps one lease while requests and jobs are counted in memory; with the app stopped none is live and the folder can go: `sudo docker compose stop app`, then `sudo docker compose run --rm --no-deps --entrypoint rm app -rf /var/lib/plaingym/restore-activity`, then `sudo docker compose up -d`. Leave `restore-state.json` and `staging/` alone: a staged restore resumes when the app starts. |
| `Unexpected error (NAME)` | Any other failure, with only the error's name. |

Fix what the reason names. If the resume hint appeared, a restore is staged and a new
`restore` is refused, so finish it as below; otherwise run the command again.

## If a restore is interrupted

A verified restore resumes by itself when the app restarts (`sudo docker compose up -d`): the
container's entrypoint resumes it before migrations or any request. If the wizard says the
restore failed, check the bucket, credentials, snapshot ID and key against the
[errors](#restore-errors), then start it again.

## How `restore.sh` works

`restore.sh SNAPSHOT_ID CONFIG_JSON KEY_FILE` streams both host files to the maintenance CLI,
which writes an app-owned 0700 directory and 0600 files on the data volume, sets the key path
automatically, and removes those copies on success or failure. The installer supplies it, and
each release's update refreshes it. A forcibly killed helper can leave a private
`restore-input-*` directory on the data volume; remove that directory once no helper uses it.
Resume uses the verified restore staging, not those input files.

The lower-level command remains `gym-app restore SNAPSHOT_ID --config PRIVATE_JSON_FILE`. For
that command, the JSON also needs `identityFile` naming a key file already inside the app
container, and you manage those files yourself (copy them in again after any edit: the
container keeps the copy it was given).
