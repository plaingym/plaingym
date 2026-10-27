<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# System health

`GET /api/health` requires `settings.manage`. The page renders all contracted tiles,
including providers that are not configured. Each provider uses the frozen
`HealthTileProvider` interface; failures and malformed payloads become an unavailable
tile without exposing exception messages. Responses are not cached.

The default route uses `createStatusProviders()` with the process environment.
`configureHealthStatus({ env, providers })` lets runtime supply its explicit environment
and additional providers. `createHealthService` and `createStatusRoutes` support isolated
composition. Additional providers must have unique IDs from `healthTileIds`.

Backup checks use `backup_runs` in system context only after the backup configuration
matches the requesting gym. Multi mode exposes no install snapshot history. Successful
records must still appear in the authenticated object inventory (complete dump, manifest,
references, and upload blobs). This checks backup availability and reference authentication;
it does not decrypt backups or replace a restore drill. Age starts at the dump snapshot,
with a warning after two hours. Capacity includes current storage, one more database and
manifest, and the backup runner's 128 MiB reserve. A failed inventory stops pruning.
No bucket names, filesystem paths, job errors, or SMTP credentials enter responses.

The SMTP check validates configuration rather than attempting a send. It uses
`SmtpResolver.source(gymId)` to report gym versus install configuration.
Last test time remains unknown because the resolver does not provide it.

TODO: add an oldest failure timestamp to `JobStatsQuery`; the response uses null rather
than the pending-job timestamp. Disk details hold the volume with least free space; the
message reports both uploads and staging. TODO: allow separate volume details. Disk warning
means less than 10% or 1 GiB available; error means less than the backup reserve (128 MiB).
Running version uses `APP_VERSION`, falling back to the current package version.
The image sets `APP_VERSION` from its `VERSION` build argument.
