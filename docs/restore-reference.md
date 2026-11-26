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

A snapshot is taken while its own backup is still running. After a restore, the backup run that
took the restored snapshot counts as a successful backup, and any other run the snapshot caught in
progress is marked failed. For these runs, the completion time records when restore settled
the run. System health uses the original start time for the snapshot's age.
A backup job the snapshot caught running is marked failed and
acknowledged. **System health → Background jobs** still shows any other unacknowledged failures.
Restore applies these rules to existing snapshots as well.

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
  only the restored records: with no Stripe payments or refunds in progress it is clear and the item reads
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

While draining active requests and jobs, the CLI prints the PID it is waiting on every
five seconds. After five minutes without drain progress it stops with the timeout below; it does not continue
to overwrite the database. Check that PID's app logs for `restore.activity_monitor_failed`
(the operation and error code identify a journal read or lease-maintenance failure).
Resolve the failure, stop the app, then resume the staged restore. Keep the journal and
staging files. All app and maintenance processes must share the data volume and PID namespace.
The five-minute timer resets whenever an admitted operation in this process finishes
or a waiting PID leaves. Repeated monitor errors are logged once while persistent
and logged again if they recur after a successful check.

| Reason | What to check |
| :--- | :--- |
| `Cannot read the restore configuration file (CODE)` | The path, and that the file is inside the container (`ENOENT` is a missing file, `EACCES` a file the app can't read). |
| `The restore configuration file is not valid JSON` | The file's syntax (`python3 -m json.tool restore.json`). |
| `The restore configuration file has invalid fields: NAMES` | The fields named: missing, empty or wrongly formed. A field the file has that the command doesn't know is counted (`(1 unrecognized field)`), not named; look for a misspelled name next to a missing one. |
| `SNAPSHOT is not a snapshot ID (a UUID)` | The ID you passed. |
| `The restore configuration names a different snapshot than SNAPSHOT` | The `snapshotId` field, if you set one. |
| `Cannot read the key file (CODE)` | `identityFile` in the configuration, and that the file is inside the container. |
| `The backup bucket rejected the access key or secret (CODE)` | The access key ID and secret: the bucket refused them (such as `SignatureDoesNotMatch` for a wrong secret, `InvalidAccessKeyId`, `InvalidToken`, `ExpiredToken`, `Unauthorized` or `HTTP 401`). |
| `The backup bucket refused access (CODE); check the key's permissions on this bucket and the snapshot ID` | The key is known, but the bucket refused it (`AccessDenied`, or another error code the bucket named with the refusal): the key's permissions and the bucket's policy for reading this bucket. A key that may read objects but not list the bucket is refused a snapshot that isn't there too, so check the snapshot ID as well. |
| `The backup bucket refused the request (CODE); check the access key and secret, the key's permissions on this bucket, and the snapshot ID` | The bucket refused the request with no error code: CODE is `HTTP 403`, or a generic error name such as `Forbidden`. A request that reads only an object's details gets an answer with no error code, so a wrong secret looks the same as a missing permission here: check the access key ID and secret first, then the key's permissions and the bucket's policy, then the snapshot ID. |
| `The backup bucket doesn't exist (NoSuchBucket)` | The bucket name, endpoint and region. |
| `The snapshot isn't in the backup bucket (CODE); check the snapshot ID` | The snapshot ID (`NoSuchKey` or `NotFound`). |
| `The backup bucket answered with error CODE` | Any other error code from the bucket (such as `InternalError`, `RequestTimeTooSkewed`, or `HTTP` and a status): the region, endpoint and the storage service's status; for `RequestTimeTooSkewed`, the server clock. |
| `Cannot reach the backup bucket (CODE)` | The `endpoint` and the server's network connection. `ECONNREFUSED` and `ENOTFOUND` mean nothing answered at that address; `ECONNRESET`, `EPIPE` and `ECONNABORTED` mean the connection dropped, also while a snapshot file was downloading. The code is left out when the error names none. |
| `The connection to the backup bucket failed (CODE)` | The request got no answer from the bucket, for a reason other than a refused connection, a failed name lookup, a dropped connection or a timeout; the code (left out when the error names none) says which. Most often a certificate or protocol problem on the way to the bucket (such as `CERT_HAS_EXPIRED`): check the endpoint's certificate and the server's clock. |
| `The snapshot was not found in the bucket` | The snapshot ID: the bucket exists but holds no manifest for that snapshot (a missing bucket reads as `The backup bucket doesn't exist (NoSuchBucket)`). |
| `The key doesn't open this snapshot` | That the key file is the private key for the backup key the snapshot was made with. |
| `The key file doesn't hold an age private key`, `The key file must hold exactly one age private key` | The key file's content, including a mistyped character that breaks its checksum. |
| `A snapshot object is missing from the bucket` | The snapshot is damaged or partly deleted: try an earlier one. |
| `A verified restore is already staged; resume it first` | See [If a restore is interrupted](#if-a-restore-is-interrupted). |
| `A restore may be staged; preserve the restore state and run resume` | Writing the journal and reading it back both failed, so activation is uncertain. Fix the filesystem error and run `resume`; it resumes a published journal or removes abandoned staging when none was published. If a backup is running, it leaves that staging for a later start or `resume`. |
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
| `This restore was started by a release before v0.8.0; resume it with that release, then update` | A restore an older release stopped after rekeying can't be resumed by this release: start the release that began the restore (the `APP_IMAGE` it ran), let it resume, then update. Nothing was changed; the journal and staging are kept. |
| `Unexpected uploads directory during restore` | An uploads directory appeared during the switch. Preserve the current and staged trees and investigate. |
| `Restored uploads tree missing` | The staged and destination upload trees are missing. Preserve the journal and recover the staged files before resuming. |
| `MAINTENANCE_DATABASE_URL must name the maintenance database role` | The user in MAINTENANCE_DATABASE_URL: the maintenance commands (migrate, snapshot, restore, resume, rotate-key, restore-connect) connect only as `maintenance`. |
| `Usage: restore SNAPSHOT --config PRIVATE_JSON_FILE` | Supply the snapshot ID and --config followed by the private configuration filename. |
| `The snapshot's contents are not in a format this version reads` | Use a compatible snapshot and app version. Snapshot field names and values aren't printed. |
| `The snapshot is damaged; try an earlier one` | Snapshot metadata, authentication or checksums failed before activation. Nothing was restored; use an intact earlier snapshot. |
| `The staged restore failed; preserve the restore state and check the server before retrying resume` | A failure after activation, including damaged staged files, a database restore failure, or a disk error just after the restore journal was written. Keep the journal and staged files, investigate the server and storage, then retry `resume` once the cause is resolved. An earlier snapshot can't replace an active restore. |
| `The staged restore failed: the uploads bucket answered with error CODE; preserve the restore state, fix the uploads bucket, then retry resume` | An install that keeps uploads in S3: its uploads bucket (`UPLOADS_S3_*`, not the backup bucket) refused to take the restored files, with that error code (`HTTP` and a status when it names none). When it reads `the uploads bucket rejected the access key or secret (CODE)` instead, fix its access keys; when it reads `the uploads bucket refused access (CODE); check the key's permissions on this bucket`, its key's permissions or the bucket's policy; when it reads `the uploads bucket refused the request (CODE); check the access key and secret, the key's permissions on this bucket`, the bucket named no reason, so check its access keys first, then its key's permissions; when it reads `the uploads bucket doesn't exist (NoSuchBucket)`, its bucket name and endpoint. Then resume. |
| `The staged restore failed: cannot reach the uploads bucket (CODE); preserve the restore state, fix the uploads bucket, then retry resume` | The uploads bucket's endpoint didn't answer (`ECONNREFUSED`, `ENOTFOUND`, a dropped connection such as `EPIPE`, or a timeout). Check `UPLOADS_S3_ENDPOINT` and the network, then resume. When it reads `the connection to the uploads bucket failed (CODE)` instead, the request got no answer for another reason, most often the endpoint's certificate (such as `CERT_HAS_EXPIRED`): check that certificate and the server's clock, then resume. |
| `The restore activity lease is invalid; stop the app, delete the restore-activity folder on its data volume, then start the app` | A process lease file on the data volume is invalid or oversized. Each process keeps one lease while requests and jobs are counted in memory; with the app stopped none is live and the folder can go: `sudo docker compose stop app`, then `sudo docker compose run --rm --no-deps --entrypoint rm app -rf /var/lib/plaingym/restore-activity`, then `sudo docker compose up -d`. Leave `restore-state.json` and `staging/` alone: a staged restore resumes when the app starts. |
| `Timed out waiting for restore activity to drain; stop the app, then retry resume` | The PIDs printed during the drain and their app logs. Stop the app before resuming; keep `restore-state.json` and staging. |
| `Unexpected error (NAME)` | Any other failure, with only the error's name. |

Fix what the reason names. If the resume hint appeared, a restore is staged and a new
`restore` is refused, so finish it as below; otherwise run the command again.

## If a restore is interrupted

A verified restore resumes by itself when the app restarts (`sudo docker compose up -d`): the
container's entrypoint resumes it before migrations or any request. If the wizard says the
restore failed, it names the cause: rejected storage credentials, a refused access (the key's
permissions, or the snapshot ID), a missing bucket or snapshot,
an endpoint it couldn't reach, a private key that doesn't open the snapshot or isn't one, or a
damaged snapshot. Fix that (the [errors](#restore-errors) say what to check), then start it
again. A failed restore's message mentions the maintenance command only when a verified
restore is staged. If the server stops answering while a restore runs, the page says so and
keeps checking. A setup page that can't load because a restore holds the server (one running,
or one staged and waiting to finish) says to wait and try again; if that stays, to restart the
app; and only if it still stays, to resume the restore with the maintenance command.

Under the backup lock, starting a new restore removes abandoned `restore-*` staging
folders when no restore is active. `resume` does the same when the journal is absent
or complete. An unfinished or unreadable journal preserves its staging for recovery.

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
