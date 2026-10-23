<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Go-live switches

`createGoLiveService({ smtpConfigured, scope, clock })` supplies the existing go-live
GET and PATCH contracts. Runtime composition calls `configureGoLive` with the gym's
SMTP resolver (or the demo transport's configured check). Until configured, routes
return 503. Route generation can discover both endpoints without opening a database
or loading credentials.

Reads return only switches, revision, and the contract's complete readiness checklist.
Readiness checks are scoped to the gym: setup completion, non-erased members, class
templates, payment configuration, SMTP, and backup configuration. Saved cards,
waivers, payment notifications, and reconciliation report `not_applicable` until
their checks are implemented. The checklist is informational; it does not gate these
switches. The billing and email services own enforcement when performing actions.

Updates compare revisions and audit the before/after switch values in the same short
transaction. Credentials and other gym settings never appear in responses or audits.
The SMTP resolver runs outside transactions because it opens its own gym scope.

The web settings registration requires `go_live.manage`, renders every returned
checklist item, and reloads current values on a revision conflict.
