<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Storage adapters

Import `LocalUploads`, `S3Uploads`, `S3BackupObjectStore`, or `createS3Client` from
`infra/storage/index.ts`. The existing interfaces and in-memory fakes are unchanged.
Every storage operation rejects calls inside application database transactions.

`LocalUploads` takes `{ root, gymId, downloadUrl, signingKey, clock? }`.
`downloadUrl` is the absolute URL of the application's download handler, without a
query string. `signingKey` must contain at least 32 random bytes and remain stable
across restarts. The handler resolves the gym, creates its adapter, and passes the
full request URL to `getSigned()`. A null result means the link is invalid, expired,
or unavailable. The handler streams valid results and uses `head(key)` for content
type. Signed URLs expire at the exact expiry instant and are bound to the gym,
key, configured origin, and path. No HTTP route is mounted by this module; the
runtime mounts `core/uploads-download.ts` at `uploadDownloadPath`
(`/api/uploads/download`).

Local disk uses private directories and files (0700/0600 on systems supporting
POSIX permissions), a SHA-256 directory name per gym and per logical key, and
streamed writes to a temporary file. The body is renamed into place before its
metadata is published. Logical keys remain `gymId/path`; they are never interpreted
as filesystem paths; the key index (`index/`) and listable sweep markers (`swept/`)
sit beside the record directories. Preserve the entire root directory when moving or
restoring uploads, including reservation records, deletion markers, and the index. The storage root is
application-owned and must not be writable by other users.

Both upload adapters reserve keys atomically across processes. Reservations are
permanent, including after a failed write or sweep; retry a failed upload using a
new key. Separate, monotonic deletion and sweep markers prevent delayed operations
from reviving deleted files. The one exception is `restore()` on the adapter
classes (not the `Uploads` interface), used only by install restore under the
backup lock with admission closed: it publishes a snapshot's file under its key,
keeps an already stored file, and clears a deletion marker; a swept key fails. `markDeleted()` retains readable bytes. Call `sweep()`
only while holding the backup lock and pass all keys protected by the snapshot.
An interrupted sweep is retried on its next run. Failed writes can leave private,
unpublished objects; never reuse or manually remove their reservations.

Both upload adapters keep a key index: one empty entry per reserved key that isn't
swept, named by the hex of the key's bytes after the gym prefix (a long or
ill-formed key gets the hex of its first 80 bytes and its digest). `put()` writes the
entry before the reservation, so every reserved key has one, and removes it again
when the reservation fails with nothing reserved or the key is swept; `sweep()`
removes it after the sweep marker and the blob, and `restore()` writes it again. `list(prefix)`
reads only the entries under the prefix and their records, so it costs in proportion
to the keys under the prefix, and swept keys cost nothing. Entries without a
published, unswept record of the gym (a crash before or after the reservation) are
skipped. The first `list()` of a store in each process, and every `sweep()`,
reconciles the index: it lists the entries, the records and the listable
sweep markers, and indexes every record that has no entry and isn't swept, reading
only those; it also removes the blob a sweep by an older release left behind. A
store written before the index existed, or by an older release after it, lists
correctly with no owner step; its first listing waits for this backfill. A key a
sweep's own reconciliation indexes is not removed until the next sweep, because the
caller's protected keys came from a listing that could not include it. Another
process running a release from before the index can write keys that this process
lists only after its next sweep or restart, so don't run both releases side by side.
On S3, the reconciliation lists without reading objects (1,000 names a request), a
sweep reads only records with a deletion marker, a record and its markers are read
together, and up to 16 keys are read at a time.

`createS3Client(config)` defaults to region `auto` and path-style addressing, and
sets request and response checksum policies to `WHEN_REQUIRED`. Its default HTTP
handler enforces a 30-second request timeout (including failure rather than just
logging a timeout); a caller supplying its own handler owns that handler's limits.
The timer covers sending the request body, so a multipart part gets at least the
time it needs at about 128 kbit/s, and completing an upload gets ten minutes.
The client sends no `Expect: 100-continue` header: the handler would hold a part's
body until that same timer ended on a provider or proxy that never answers it.
Pass an endpoint
and explicit credentials for an S3-compatible provider. `S3Uploads` takes
`{ client, bucket, gymId, clock? }`; `S3BackupObjectStore` takes
`{ client, bucket, clock? }`. Close the client with `client.destroy()` on shutdown.
Upload records, deletion markers, sweep markers, index entries, and immutable blobs
live below `gymId/.storage/`. Use a separate backup bucket so retention cannot remove upload
reservations. S3 upload URLs use the AWS SDK presigner and expire within seven days.
The bucket must support conditional `PutObject` with `If-None-Match: *` and strong
read-after-write consistency. Do not apply lifecycle deletion to reservations,
markers, or index entries. Bucket permissions must permit object get/head/list/put/delete, multipart
create/upload/complete/abort, and the conditional writes.

Backup objects use one multipart request at a time, with fixed 8 MiB parts by
default. `partSize` may be 5–64 MiB; only the final part may be shorter. Inputs are
streamed with backpressure, and the 10,000-part S3 limit is checked. Input failure,
part failure, completion failure, and cancellation trigger multipart abort without
inheriting the canceled signal. Abort failures surface together with the original
failure as an `AggregateError`, so cleanup failures are visible to the caller.

`Uploads.get/head` and `BackupObjectStore.getObject/headObject` accept optional
`{ signal }` read options. Durable uploads forward the signal through metadata,
deletion/sweep markers, and object reads. Local reads cancel their file streams;
S3 sends receive `abortSignal`, and cancellation also propagates through body
consumption after headers arrive. Existing callers may omit the options. Fakes
honor the same read cancellation contract.
`markDeleted` accepts the same option for its preliminary metadata read; a marker
write already in progress finishes normally. Import preview cleanup passes a
short limit of its own, so a stuck cleanup read cannot retain its memory slot.
When that limit prevents cleanup, upload retention removes the partial files.
As with any remote object API, a lost response after server-side completion has an
uncertain outcome; callers should inspect the key before retrying a publication.

`storage.test.ts` runs the shared contracts against the fakes, local disk, and real
S3 SDK requests to a loopback HTTP protocol fixture. It also verifies atomic
reservations across clients and restarts, transaction guards inside real `forGym`
transactions, pagination, signed downloads, fixed part sizes, and failure cleanup.
`storage.index.test.ts` covers the key index on both adapters: stores written before
it, interrupted backfills, crashes around the reservation, restore, other gyms, long
and ill-formed keys, and the S3 requests a listing and a sweep make.
