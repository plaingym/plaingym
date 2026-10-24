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
as filesystem paths. Preserve the entire root directory when moving or restoring
uploads, including reservation records and deletion markers. The storage root is
application-owned and must not be writable by other users.

Both upload adapters reserve keys atomically across processes. Reservations are
permanent, including after a failed write or sweep; retry a failed upload using a
new key. Separate, monotonic deletion and sweep markers prevent delayed operations
from reviving deleted files. `markDeleted()` retains readable bytes. Call `sweep()`
only while holding the backup lock and pass all keys protected by the snapshot.
An interrupted sweep is retried on its next run. Failed writes can leave private,
unpublished objects; never reuse or manually remove their reservations.

`createS3Client(config)` defaults to region `auto` and path-style addressing, and
sets request and response checksum policies to `WHEN_REQUIRED`. Pass an endpoint
and explicit credentials for an S3-compatible provider. `S3Uploads` takes
`{ client, bucket, gymId, clock? }`; `S3BackupObjectStore` takes
`{ client, bucket, clock? }`. Close the client with `client.destroy()` on shutdown.
Upload records, deletion markers, sweep markers, and immutable blobs live below
`gymId/.storage/`. Use a separate backup bucket so retention cannot remove upload
reservations. S3 upload URLs use the AWS SDK presigner and expire within seven days.
The bucket must support conditional `PutObject` with `If-None-Match: *` and strong
read-after-write consistency. Do not apply lifecycle deletion to reservations or
markers. Bucket permissions must permit object get/head/list/put/delete, multipart
create/upload/complete/abort, and the conditional writes.

Backup objects use one multipart request at a time, with fixed 8 MiB parts by
default. `partSize` may be 5–64 MiB; only the final part may be shorter. Inputs are
streamed with backpressure, and the 10,000-part S3 limit is checked. Input failure,
part failure, completion failure, and cancellation trigger multipart abort without
inheriting the canceled signal. Abort failures surface together with the original
failure as an `AggregateError`, so cleanup failures are visible to the caller.
As with any remote object API, a lost response after server-side completion has an
uncertain outcome; callers should inspect the key before retrying a publication.

`storage.test.ts` runs the shared contracts against the fakes, local disk, and real
S3 SDK requests to a loopback HTTP protocol fixture. It also verifies atomic
reservations across clients and restarts, transaction guards inside real `forGym`
transactions, pagination, signed downloads, fixed part sizes, and failure cleanup.
