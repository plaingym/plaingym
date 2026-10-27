<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Install backup and restore protocol

The maintenance bundle runs independently of the HTTP server:

```sh
node maintenance.mjs migrate
node maintenance.mjs snapshot
node maintenance.mjs snapshot pre-upgrade
node maintenance.mjs restore SNAPSHOT_UUID --config /private/restore.json
node maintenance.mjs resume
```

It reads `MAINTENANCE_DATABASE_URL`, `APP_ENCRYPTION_KEY`, `BACKUP_STAGING_DIR`,
`UPLOADS_DIR`, and the `UPLOADS_S3_*` settings when uploads live in S3: snapshots
read uploads through the same storage resolver as the app. Snapshot creation also reads `DATABASE_URL` and the single gym's
stored backup settings. The encrypted S3 configuration holds `accessKeyId` and
`secretAccessKey`; `backup_destination` holds `bucket`, optional `endpoint`, and
`region` (default `auto`). The gym also stores its native age public recipient,
encrypted 32-byte blob-naming key, and retention byte budget.

A fresh-install restore uses an owner-provided private JSON file with `bucket`,
optional `endpoint`, `region`, `accessKeyId`, `secretAccessKey`, and `identityFile`
(the path to one age private identity, allowing age-keygen comment lines).
Credentials and private identities never belong in command arguments or logs.
Keep that file and staging on the private data volume with permissions 0600/0700.

## Snapshot publication

A dedicated maintenance connection holds the install-wide advisory backup lock.
All snapshot kinds, pruning, upload sweeping, and restore take that same lock.
Each dump finishes into local staging before remote I/O begins. Files are
immutable; files marked deleted since the run began remain included.

Each snapshot has `snapshots/UUID/database.age`, `manifest.age`, and
`references.json`. The age-encrypted manifest contains the source app key,
blob-naming key, plaintext checksums, and complete upload paths and metadata.
Blobs use HMAC-derived names including the upload content and recipient, so a
public-recipient rotation never reuses ciphertext encrypted to the old recipient.

The final reference list authenticates the snapshot ID, timestamp, kind, dump,
manifest, and every blob. It contains only opaque upload identifiers and encrypted
checksums: paths and plaintext content hashes stay inside the encrypted manifest.
Publishing this list commits a snapshot. Multipart failures abort and retry from
the encrypted staging file. Install-level jobs use durable occurrence keys.

Retention shares snapshots between 24 hourly, 7 daily, and 4 weekly buckets,
plus two pre-upgrade snapshots no older than 30 days. Pruning first validates all
reference lists and referenced blob sizes. Each run is recorded in `backup_runs`
before anything is uploaded, and runs hold the backup lock, so a prefix with no
reference list whose run never succeeded is an abandoned publication: pruning
deletes it and the blobs no committed snapshot references. A committed snapshot
with a missing object is an interrupted deletion when the retention policy would
drop it anyway, and pruning finishes it; when the policy would keep it, or when a
reference list is missing for a successful run, invalid, or unexplained, pruning
and sweeping stop. Stopped pruning never stops the next snapshot: it publishes,
deletes nothing, and references already stored blobs as they are instead of
re-encrypting over them. Every retained upload is protected from sweeping.
A budget failure is reported instead of silently dropping the recovery objective;
the default budget is 8 GB with 128 MiB of in-flight reserve.

## Restore activation and recovery

Restore downloads and verifies the manifest, dump, recovery keys, and every blob
before closing admission or changing the current database or uploads. For an
uploads directory it builds a complete LocalUploads tree in staging on the same
filesystem as uploads. When the install keeps uploads in S3, it stages the
verified plaintext files instead; the journal records which target it chose, and
a restart with a different storage configuration refuses to continue.

The restore journal and request/job activity leases live on the data volume,
outside the overwritten database. `RestoreGate.middleware()` wraps requests;
`RestoreGate.activity()` wraps each worker execution. All application and CLI
processes on an install share the container PID namespace and data volume.
Closing the gate waits for admitted work to finish. Linux process-start ticks
allow abandoned leases to be distinguished from reused PIDs after restart.
A service using the gate must never initiate restore from inside its own activity
lease: the setup coordinator calls the service outside the wrapped request.

After activation, the restore resets the owned schemas, runs transactional
pg_restore, migrates forward, and applies the same security/catalog check as boot.
One short transaction re-encrypts every field in the encrypted-field registry,
preserves QR key plaintext, pauses billing, and writes restore audit events.
The external journal commits each uploads rename before reopening admission.
With S3 uploads, the switch instead marks every stored file that the snapshot
doesn't contain as deleted (so the next sweep removes it, as the directory restore
discards the old tree), then restores each snapshot file under its key: missing
files are published, stored ones kept, and deletions marked after the snapshot
cleared, so a sweep never removes a file the restored database references. Both
steps are idempotent and repeat from the start after a restart.

Before marking the journal complete, restore queues one `billing.runner.restore`
job per restored gym with the manifest's snapshot time and that gym's new
`restore.completed` audit ID. Publication uses a dedicated maintenance connection
and the production Postgres queue, including in the standalone maintenance CLI.
The restore audit ID is the idempotency key: an interruption after enqueue and
before journal completion reuses the existing job. The worker runs after admission
reopens. It never enables billing. The go-live page displays the latest check and
lets a manager rerun it after resolving issues, then explicitly enable billing.

A restart resumes without needing to retain the age private identity.
Before the rekey receipt it repeats reset/restore/migrate/rekey from verified
staging; after that receipt it resumes the recorded uploads switch. Completed
journals also finish any interrupted staging/previous-uploads cleanup.
Container startup runs recovery and migrations before starting the HTTP server.

The application entry point must connect the gate and system-job scheduler.
The service factories expose these dependencies so composition and tests use the
same implementation.
