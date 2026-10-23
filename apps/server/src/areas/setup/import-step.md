<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Import or start fresh

`createImportStep({ imports, scope, clock })` accepts the import pipeline's gym-scoped
`get` method. `finish(setup, context, input)` delegates fresh starts to the setup
service. For an import, it requires the original setup owner, the completed backup
step, a current revision, and a successful committed import belonging to that gym.
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

Composition: pass the runtime's `importPipeline` to `configureImportStep`, and have
the existing setup finish handler call `importStep().finish(service, context, input)`.
Keep that endpoint's existing permission and setup-owner checks. Registering another
route with the same path would duplicate the frozen setup contract. Tests exercise
the existing route factory with its finish method composed this way.

The web contribution exports `ImportStep` through `setupSteps.setup.import`.
The wizard must render this registered component at step 8 after backup confirmation,
instead of finishing directly at step 7. The current import finish contract cannot
carry `skipBackups`; supporting imports after deferring backups requires that
contract extension and the corresponding setup progress transition.
