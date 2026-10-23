<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Import or start fresh

`createImportStep({ imports, scope, clock })` accepts the import pipeline's gym-scoped
`get` method. `finish(setup, context, input)` delegates fresh starts to the setup
service. For an import, it requires the original setup owner, the completed backup
step (or the payments step when `skipBackups` defers backups), a current revision,
and a successful committed import belonging to that gym.
An unknown or other-gym import returns 404. A running import returns 409.

Import progress is read from storage between short database transactions. Finishing
rechecks ownership, setup progress, and revision under a row lock, then marks setup
complete, switches billing and member emails off, and writes both setup audit events
in the same transaction. The audit records the import ID, mapper, and row count,
without uploaded personal details.

The import form offers the pipeline's duplicate policies: report an error, skip,
or update one match. A failed run displays its row errors with pagination. If some
rows were committed, the form explains that they remain saved: correct the CSV,
choose skip to keep existing records or update to apply corrections, and run
another dry run before committing. Changing the file, mapping, mapper, or duplicate
policy invalidates the previous dry run. Error-list failures can be retried without
starting another import; setup can finish only with a successful committed run.

Deferring backups (`skipBackups: true`, on either choice) clears any backup destination
whose key was never confirmed, as a fresh finish does, and records step 8 without step 7.

Composition: the runtime passes its `importPipeline` to `configureImportStep`, and the
setup finish route calls `importStep().finish(service, context, input)` with its existing
permission and setup-owner checks. Without a configured pipeline, import finishes fail
closed.

The web contribution exports `ImportStep` through `setupSteps.setup.import`, which the
wizard renders at step 8, after the backup key is confirmed or backups are set up later.
The step sends `skipBackups` when the backup step is not complete; the wizard offers a
way back to the backup step in that case.
