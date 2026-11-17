<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# System health and recovery

Health services report install status and coordinate backups, restore, updates,
and charge-run health. See [backup and restore protocol](backups.protocol.md),
[status providers](status.README.md), [automatic updates](auto-update.README.md),
and [charge-run health](charge-run.README.md) for their individual contracts.

Restore's queued payment check and the go-live rerun share a per-gym database
session lease configured from the runtime's database URL. If a queued check finds
the lease busy, its job succeeds while the holder records the check's result.
Billing remains paused until the go-live checklist permits the owner to enable it.

When no restore journal exists, startup only sweeps abandoned staging if it can
take the backup lock immediately. A running backup therefore postpones cleanup
without delaying startup. Unfinished restore journals retain their staged files
and follow the normal recovery and drain procedure.

The activity monitor retries failures every tick but logs each operation and error
kind once per episode: an episode ends after five seconds without that failure,
so a failure seen after such a gap logs again. Intermittent failures stay in the
same log episode; leases remain durable.
