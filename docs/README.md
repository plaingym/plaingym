<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Documentation

| Document | For | What it covers |
| :--- | :--- | :--- |
| [self-hosting.md](self-hosting.md) | Gym owners and operators | Installing on a server, the setup wizard, Stripe, sign-in, backups and restore, updates, day-to-day operation. |
| [install.md](install.md) | Gym owners and operators | Step-by-step install: one command, cloud-init, or Docker Compose by hand. |
| [updating.md](updating.md) | Gym owners and operators | Moving to a new release, what the updater does, and what to do when it stops. |
| [versioning.md](versioning.md) | Owners and maintainers | Version meanings, compatibility, build identity, and preparing a signed release. |
| [restoring.md](restoring.md) | Gym owners and operators | Bringing a gym back from a backup, from the setup wizard or the command line, and what to check afterwards. |
| [importing.md](importing.md) | Gym owners | Importing members, memberships, ranks and attendance from another system with CSV files. |
| [card-recollection.md](card-recollection.md) | Gym owners | Collecting cards again after an import, with campaign links. |
| [member-portal.md](member-portal.md) | Gym owners and staff | Class and booking rules, inviting members to the portal, and what members see. |
| [going-live.md](going-live.md) | Gym owners | Turning on billing and member emails: readiness checklist, switching over, first billing cycle. |
| [demo.md](demo.md) | Gym owners and evaluators | Running a sandbox demo on your computer or a server. |
| [configuration.md](configuration.md) | Operators | Every environment variable, with its default and meaning. |
| [architecture.md](architecture.md) | Contributors | How the server, web app, database and jobs fit together, and where each part lives. |
| [security-model.md](security-model.md) | Contributors, reviewers, operators | Gym and household isolation, roles and capabilities, sign-in, request protections, secrets and personal data. |

A gym owner who starts from nothing reads the guides in this order: [install](install.md),
the setup wizard in [self-hosting.md](self-hosting.md#setup-wizard),
[importing](importing.md), [card re-collection](card-recollection.md), the
[member portal](member-portal.md), then [going live](going-live.md); [updating](updating.md)
and [restoring](restoring.md) are for later.

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
