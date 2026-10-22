# Contributing

Thanks for helping build open-source gym software. This guide covers licensing, the Contributor License Agreement, and what a pull request needs before it can be merged.

## License

Application code is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

We commit to keeping the application open source under AGPL-3.0-only.

## Contributor License Agreement (CLA)

Before your first pull request can be merged, you sign our [Contributor License Agreement](CLA.md) once, by replying to the CLA check's comment on the pull request. It covers all of your past and future contributions.

* **You keep the copyright** to your work. The CLA is a license grant, not a copyright assignment.
* It gives the maintainer a broad license to your contribution, including the right to offer the project under other licenses alongside the AGPL (for example, a commercial license for an organization that can't use the AGPL).
* **Every version published under AGPL-3.0-only stays available under it.**
* It includes a patent license, and you confirm that you have the right to contribute what you submit (including your employer's permission, if needed).

## Branches and Pull Requests

* `main` is the only long-lived branch. Fork the repository, branch from `main`, and open your pull request against `main`.
* Keep each pull request small and focused on one change.
* Pull requests are squash-merged, so the PR title becomes the commit message on `main`. Write it as a conventional commit (`feat: …`, `fix: …`).

## Before You Open a Pull Request

* Read [`AGENTS.md`](AGENTS.md). It holds the project's engineering rules (authorization, schema, billing safety, vendor modules, discipline-agnostic core) and applies to human and AI contributors alike.
* Use conventional commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) with a concise body, in commit messages and PR titles. Don't add AI session trailers or attribution links.
* Make sure strict type checking, lint, and tests pass: `pnpm check-types`, `pnpm lint`, `pnpm test`.
* Start every new source file with an SPDX header: `// SPDX-License-Identifier: AGPL-3.0-only`.
* New dependencies must use a license on the allowlist in `AGENTS.md`. The CI license check blocks anything else.
* Every new member-facing route needs a cross-member access test (member A gets 403/404 on member B's data).
* **Never report security issues in public issues or pull requests.** See [`SECURITY.md`](SECURITY.md).

## Using AI Tools

AI-assisted contributions are welcome. You are responsible for what you submit, and the CLA applies exactly as it does to code you typed yourself: only submit changes you understand and have the right to contribute. Don't submit code copied from proprietary sources.

## Code of Conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
