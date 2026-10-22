<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Shared primitives

The package root is browser-safe. It exports permissions, response envelopes, the
content-pack schema, translation helpers, the clock interface, and composition
registries.

## Transaction context

Node code imports the transaction marker from `@plaingym/shared/transaction`:

```ts
import { runInTransaction, assertNoTransaction } from '@plaingym/shared/transaction';

await runInTransaction(async () => {
  // Run the database transaction here.
});
assertNoTransaction('email.sendEmail');
```

`runInTransaction` propagates the marker across asynchronous calls and rejects
nesting. It marks an application transaction; it does not open a database
connection. `isInTransaction()` reports the current asynchronous context.
The subpath has a Node-only export condition and is not re-exported at the package
root.

## Permissions and responses

`staffPermissions` and `memberPermissions` are the capability maps.
`canAccessMember` checks both gym and household identity, then restricts a member
login to its own profile. A payer can act for the household without having a
member profile.

Success responses use `{ data }`. Errors use
`{ error: { code, message, details? }, requestId }`.
`AppError` represents a safe public error; `errorResponse` redacts other errors.

## Registration

The [server registry](../../apps/server/src/core/registry.ts) exports
`route(definition, handler)`, which requires a permission and retains the
OpenAPI request and response types. Its mount operation requires authorization
middleware. Module availability can be resolved separately for each request and
job.

Area `routes.ts` and `jobs.ts` files compose their part arrays. Email templates
export a `templates` array. The CLI composes command arrays. Web contributions
declare navigation, profile tabs, session panels, settings sections, portal pages,
and setup steps. Placeholder web entries are disabled; consumers must respect
`enabled`, module availability, and permissions. Navigation visibility does not
replace authorization.

The infrastructure interfaces and fakes are in
[auth](../../apps/server/src/infra/auth/index.ts),
[jobs](../../apps/server/src/infra/jobs/index.ts),
[email](../../apps/server/src/infra/email/index.ts),
[payments](../../apps/server/src/infra/payments/index.ts), and
[storage](../../apps/server/src/infra/storage/index.ts).
Reusable [contract suites](../../apps/server/src/core/registry-infra-contracts.ts)
exercise the adapter contracts.

The jobs fake runs due work explicitly with `runNext()`; scheduled occurrences
are explicitly triggered. It does not interpret cron expressions. The payments
fake supports response loss, uncertain lookups, expiring idempotency keys,
Checkout completion, refunds, disputes, and normalized payment-object retrieval.
Its webhook signature format is only for fake fixtures. Storage fakes retain
bytes in memory, while exposing streaming interfaces and multipart abort behavior.
Upload keys include the gym prefix, remain immutable after deletion, and are
removed only by an explicit sweep under the caller's backup lock.

## Generation and translations

Run `pnpm generate` to produce the TanStack route tree, typed OpenAPI fetch client,
and locale catalog. Generated output stays in ignored locations. Generation
runs automatically before type checking, development, builds, and tests.

The generated client is available at `@plaingym/shared/api`, and catalogs at
`@plaingym/shared/locales`. Translation keys have the form
`area/part:message`. `createTranslator` substitutes named `{values}` and returns
the key when a translation is missing. Locale JSON files use `$comment` for their
license notice; it is excluded from messages.
