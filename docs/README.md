<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Documentation

| Document | For | What it covers |
| :--- | :--- | :--- |
| [install.md](install.md) | Gym owners | Install PlainGym on a new server: DNS, SSH, one command, the setup link. |
| [updating.md](updating.md) | Gym owners | What happens each night: the automatic patch update, where to see its result, and what to do when it fails. |
| [update-by-hand.md](update-by-hand.md) | Gym owners | Update to a minor or major release by hand, and roll back to the previous version. |
| [restoring.md](restoring.md) | Gym owners | Restore after losing a server: from the setup wizard or the command line, and what to check afterwards. |
| [self-hosting.md](self-hosting.md) | Gym owners and operators | The overview: requirements, the setup wizard, Stripe, sign-in, backups, updates, day-to-day operation, rotating the encryption key. |
| [install-reference.md](install-reference.md) | Operators | The installer's checks and steps, the DNS check, cloud-init, Docker Compose by hand, and the update timer on a hand-made install. |
| [cloudflare.md](cloudflare.md) | Gym owners and operators | Putting the server behind Cloudflare's proxy: settings, the rate-limit rule, and what can go wrong. |
| [update-reference.md](update-reference.md) | Operators | The updater's details: banner rules, kept images, host files, the signing key, rollback floors and forward recovery. |
| [restore-reference.md](restore-reference.md) | Operators | Backup keys, payment reconciliation after a restore, every restore error, and resuming an interrupted restore. |
| [versioning.md](versioning.md) | Owners and maintainers | Version meanings, compatibility, build identity, and preparing a signed release. |
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
[member portal](member-portal.md), then [going live](going-live.md); [what happens each night](updating.md),
[updating by hand](update-by-hand.md) and [restoring](restoring.md) are for later. Each of these
task pages links to a reference page (the operator's detail) for what it leaves out.

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
