<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Documentation

| Document | For | What it covers |
| :--- | :--- | :--- |
| [self-hosting.md](self-hosting.md) | Gym owners and operators | Installing on a server, the setup wizard, Stripe, sign-in, backups and restore, updates, day-to-day operation. |
| [configuration.md](configuration.md) | Operators | Every environment variable, with its default and meaning. |
| [architecture.md](architecture.md) | Contributors | How the server, web app, database and jobs fit together, and where each part lives. |
| [security-model.md](security-model.md) | Contributors, reviewers, operators | Gym and household isolation, roles and capabilities, sign-in, request protections, secrets and personal data. |

These pages are overviews. The details live next to the code, in the READMEs they
link to (`packages/db/README.md`, `apps/server/src/infra/*/README.md`, each area's
README, `deploy/README.md`, `e2e/README.md`). Start with the root
[`README.md`](../README.md) for local development, [`CONTRIBUTING.md`](../CONTRIBUTING.md)
for contributing, and [`SECURITY.md`](../SECURITY.md) to report a vulnerability.

## Keeping them current

The documentation describes the code on `main`, as it is. A change that alters
what a page says (a new setting, route surface, permission, setup step, deploy
step or security rule) updates that page in the same commit. Two tests keep the
tables honest: `configuration.docs.test.ts` fails when the server reads an
environment variable [configuration.md](configuration.md) doesn't list, and
`permissions.docs.test.ts` fails when the capability tables in
[security-model.md](security-model.md) differ from
`packages/shared/src/permissions.ts`.
