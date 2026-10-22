<!-- SPDX-License-Identifier: AGPL-3.0-only -->
General settings and booking rules use the gym revision for compare-and-set updates. Currency changes lock the gym row and are rejected when plans, charge types, memberships, or invoices exist; currency foreign keys also protect concurrent inserts. Responses and audits use the same explicit safe projection and exclude credentials and opaque settings.

The module helpers take the existing server registry and inspect request context or job gym settings at execution time. The website definition remains a stub; core does not import it.

Gym creation reserves the gym and primary domain in an audited system transaction through `core/tenancy-bootstrap.ts`. The new gym ID scopes the audit in that transaction. A retry must match the original slug, hostname, owner email, name, timezone, and currency; unrelated existing gyms are rejected.

After reservation commits, `createOwnerService` provisions the identity and owner role together, then sends a gym-bound magic link outside the transaction. The default CLI uses this service directly and returns gym/user IDs and delivery status. A failure leaves a reservation that an identical retry can resume; uniqueness constraints prevent duplicate identities or owner roles. Delivery retries may resend a link. Staff invitation management is a separate service.
