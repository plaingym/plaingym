<!-- SPDX-License-Identifier: AGPL-3.0-only -->
General settings and booking rules use the gym revision for compare-and-set updates. Currency changes lock the gym row and are rejected when plans, charge types, memberships, or invoices exist; currency foreign keys also protect concurrent inserts. Responses and audits use the same explicit safe projection and exclude credentials and opaque settings.

The module helpers take the existing server registry and inspect request context or job gym settings at execution time. The website definition remains a stub; core does not import it.

Gym creation takes a transaction-local owner invitation provisioning callback. It must persist the invitation in that transaction, perform no network I/O, and return its one-time URL. Without this callback, the CLI refuses creation and rolls back the gym and domain. The invitation acceptance service must grant ownership only after identity verification. Invitation delivery occurs after commit.

The injected bootstrap path also needs an audited transaction before production use: system context can create gym configuration but cannot write gym-owned audit rows, and the current scoped API rejects nested transactions. General settings mutations already audit inside their gym transaction.
