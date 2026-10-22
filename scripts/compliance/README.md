<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Repository compliance

Run `pnpm compliance` to execute the regression fixtures, check tracked source
headers, build the server and web bundles in memory to record their inputs, audit
installed production and development dependencies, verify bundled assets, and
compare the generated notices with `THIRD_PARTY_LICENSES`.
Use `pnpm compliance --write` to refresh that file after a dependency change.
Use `node scripts/compliance/cli.mjs --headers` for the header check alone.
On Windows, use `pnpm.cmd`.

The workflow audits Linux and Windows installations, including the optional
dependencies installed on each platform. Missing required dependencies fail.
Intentionally skipped optional packages are identified by pnpm's install manifest.
The fixture suite runs without a database.

## Dependency policy

`license.mjs` evaluates SPDX parentheses, AND, OR, and WITH. Every AND operand
must pass; an OR expression can use an allowed alternative. Unapproved exceptions,
unrecognized licenses, malformed expressions and missing license evidence fail.
When the manifest omits its license field, LICENSE/COPYING files are examined.
A declared disallowed license cannot be replaced by a more permissive LICENSE file.

The general allowlist matches `AGENTS.md`. Exceptions belong in
`allowlist.json` under `approvals`, with exact `name`, `version`, `license`,
`reason`, and `approved` (the maintainer's approval date, `YYYY-MM-DD`; the commit
that adds the entry is the approval record). An approval covers build tools only:
it fails if the package is in a production closure or either bundle. Version
ranges and blanket license exceptions are rejected. Changes to this file require
maintainer review.

CC-BY-4.0's scoped allowance requires an exact entry under `buildTimePackages`
with those same fields. The package must be absent from every production closure
and both bundles. `bundles.mjs` collects the evidence on every run from the real
builds: the server's esbuild metafile and every module and asset in the web
build's output (written nowhere). Empty evidence fails closed. A dependency being
declared as a devDependency alone does not grant the allowance. OFL-1.1 applies
only to inventoried font files.

## Headers and notices

Tracked source and configuration files use their comment syntax on the first line
(or the line after a shebang or a cloud-init `#cloud-config` marker). JavaScript/TypeScript and JSONC use `//`, YAML and
shell use `#`, CSS uses `/* */`, SQL uses `--`, HTML/XML/SVG use `<!-- -->`.
Unknown tracked file types fail until classified. Strict JSON, generated lock data,
documentation and binary/data files have no source-comment requirement.
TypeScript configuration files are JSONC.

`assets.json` identifies bundled third-party assets, their hashes, licenses and
notice files. Uninventoried font files or files under asset directories fail.
The generator includes production dependency closures, known bundled dependencies,
all discovered package LICENSE/COPYING/NOTICE files, and inventoried asset notices.
Output is sorted, uses LF, and contains no machine paths or generation timestamps.

`notices/provenance.json` supplies exact package/version/license-bound,
hash-verified upstream notice copies for distributions that omit license text.
When upstream ships no license file at all, the notice reproduces the standard
terms the manifest declares, credits the author the package README names, and
links both immutable upstream files as evidence.
It does not override their declared license. Node.js and operating-system package
notices belong to the release image inventory in addition to this application file.

## Contributor agreement

`.github/workflows/cla.yml` uses only pinned `actions/github-script`.
It handles pull request and signing-comment events without checking out refs,
installing dependencies, importing repository code or executing contributor text.
The agreement is fetched from an immutable commit on the default branch.
Unresolved publication placeholders prevent external signing.

The `CLA` commit status covers the current PR author and head commit.
Repository collaborators with admin/maintain permission and the exact
dependabot/renovate bot identities are exempt. Additional maintainer GitHub numeric
user IDs can be configured with the comma-separated `CLA_MAINTAINER_IDS`
repository variable.

An unsigned author receives a prompt containing the agreement version, immutable
link and SHA-256. The author replies with the exact signing phrase from `CLA.md`.
A signature can only follow a prompt for that agreement hash. Records contain
the GitHub user ID/login, signing comment ID, timestamp, agreement version, SHA-256
and blob SHA. They are saved at `signatures/cla.json` on `cla-signatures`;
the workflow bootstraps the branch if needed and serializes writes.

The workflow requests its own write permissions, so the repository default for
the Actions token can stay read-only. Require `CLA` and the compliance checks in
the repository's branch rules. Keep the signature branch restricted to maintainers
and this workflow. Posting a comment on an open PR rechecks its author's signature.
