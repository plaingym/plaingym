<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing scenarios

Run from the repository root with Node 24.22.1 and Docker available:

```sh
pnpm exec vitest run apps/server/src/areas/billing/scenarios
```

Leave `DATABASE_URL` unset. The normal integration setup starts disposable
PostgreSQL and clones a migrated database per test file. Each scenario creates
its own gym. Files with multiple worker scenarios clear their own database's job
queue between cases so a worker cannot claim a preceding scenario's work.
Time comes from `TestClock`; there are no sleeps or increased test timeouts.

| File | Coverage |
| --- | --- |
| `calendar-pricing.test.ts` | Persisted catalog and lifecycle into pure invoice calculations: month ends, leap years, local trial expiry, DST proration, family and annual dates, freeze/resume/cancel, discounts, tax and isolation |
| `payment-provider.test.ts` | Provider contract: idempotent create/confirm, decline and SCA normalization, lost responses, payment/setup Checkout, saved methods, refunds and signed events |
| `transitions.test.ts` | PostgreSQL transitions and durable effects: receipt/activation once, dunning, paid finality, older attempts, cash/check and duplicate-card refunds, pending/failed/partial/full refunds |
| `inbox.test.ts` | Raw-byte signature rejection and durable event-ID deduplication |
| `workflows.test.ts` | First Checkout → activation → cycle charge → decline → retry → pay link; webhook before/after runner result; replay; March 1/4/8 retry deadlines and exhaustion; day-3 success and late failure; edited schedules; three SCA shapes; one-off success/decline/SCA; open/completed/uncertain Checkout at retry |
| `recovery.test.ts` | Pending request before create, intent before confirm, delayed-create compare-and-set loss, cancellation/confirmation races, crash after processor success, unknown outcome beyond 24 hours, concurrent daily runs, oldest-first catch-up and seven/eight-day holds, disabled billing |
| `lifecycle.test.ts` | CSV pipeline and import worker → first cycle, customer adoption, independent monthly/annual dates, imported Feb-29 anniversary through 2032, freeze/resume worker, adding a member and subsequent household consolidation |
| `adjustments.test.ts` | Dashboard refunds without invoice metadata, pending/failed refunds, staff refund of the remainder, dispute webhook replay with owner email/dashboard count, terminal disputes, cash permissions and gym/household isolation |
| `restore.test.ts` | Encrypted snapshot → real PostgreSQL restore → automatically queued reconciliation of a subsequent charge, refund and dispute; replay stays idempotent and billing stays disabled |
| `campaign.test.ts` | Real campaign publication/delivery → signed card Checkout webhook → completed campaign recipient without browser return; replay and later reminders, with an unfinished recipient as a positive control |

The former workflow acceptance todos are implemented across the workflow,
recovery, lifecycle, adjustment and restore files. No scenario is disabled.

`workflow-fixture.ts` composes the real charge runner, webhook inbox and handlers,
invoice transitions, signed-link checkout, membership service and payment
service. It registers their real handlers on `PostgresJobs`. Assertions inspect
invoices, attempts, payments, refunds, memberships, audits, inbox rows and jobs.
The bounded worker drain fails on unexpected job failure or backoff, so a queued
error cannot masquerade as a passing scenario.

External email and storage use their infrastructure fakes. Workflow payment calls
use `StripePayments` with the shared synthetic Stripe API transport, including
real HMAC signature verification and current-object lookups. The fixture supplies
the requested Checkout price instead of the transport's default $1 example.
These are synthetic fixtures, not recordings from a live Stripe account. The
existing focused provider tests remain useful alongside the composed workflows.

Fault injection wraps only the payment boundary: a provider call can return late,
lose its response or report an uncertain result. The real runner and reconciliation
perform all database mutations. Retry deadlines use the gym's IANA timezone.

The restore scenario snapshots the real runner's pending attempt after its intent
ID is committed and before confirmation. Stripe-side success, refund and dispute
then survive replacement of the database by the older encrypted backup. It uses
`BackupService`, `RestoreService`, and the automatically published restore job;
it does not manufacture restored invoice states. Named, disposable PostgreSQL
client containers run with a CPU cap, lower priority and a 60-second lifetime.
Temporary backup files and test containers are removed after the run.

`invoiceDetail` in the original pricing fixture is only a contract projection of
the pure engine's output. Durable issuing and lifecycle assertions belong to the
composed workflow scenarios, not that projection. Public signup page coverage
is outside this service-level suite.
