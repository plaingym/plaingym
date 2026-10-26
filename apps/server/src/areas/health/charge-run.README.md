<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing health providers

The runtime supplies both providers to the generic health route through
`configureHealthStatus({ providers: [...] })` after building its payment resolver.

`createStripeHealthProvider({ configured, webhooks })` uses the inbox's
`WebhookHealthQuery` and a boolean configuration resolver, such as
`async gymId => Boolean(await paymentsFor(gymId))`. It never reads inbox rows,
credentials or payloads. Failed processing is an error, pending processing is a
warning, and configured Stripe with no received event is a warning. Silence after
an event is not a failure: an idle gym may receive no new events.

`monitorChargeRunner(runner, { scope, clock, settings })` returns a runner whose
`daily` method records start and completion in append-only `audit_events`, with
actions `billing.runner.run.started` / `billing.runner.run.completed` and a
distinct run target. Wrap the runner before
passing it to `configureChargeRunner` / `createRunnerJobs`. Run audits contain
only timestamps, result, attempted invoice count and collection exception count.
Card declines are invoice outcomes; they do not mean the daily job itself failed.
Thrown exceptions are rethrown, without persisting processor messages. If writing
the failure audit also fails, that error is logged and the original runner error
is preserved. Billing
paused by the gym switch does not create a run record. There is no new cron job.

`createChargeRunHealthProvider({ scope, settings })` reads these durable audits,
ordering by run identity before completion time so an older concurrent run's
completion cannot hide a newer run.
An enabled gym with no recorded run gets a warning; paused billing is reported as
not configured. Failed runs are errors. A run still reporting running after two
hours or a completed run started more than 26 hours ago gets a warning. A crash
leaves its start record visible until another run records progress. The runtime
passes the monitored runner to the scheduled jobs. Its retry attachment,
`onAssigned`, `collectAssigned` and staff payment service use the original runner;
only `daily` is monitored. All times come from the injected clock.

Both providers use the health framework's `settings.manage` permission (owner or
admin). Its error boundary turns failed reads into a safe unavailable tile.
