<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Versions and releases

PlainGym uses [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html),
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), and
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
The root `package.json` is the product version. Every workspace package is private
and has that same version; packages are not released separately. The current
development version is `0.4.0`. Public tagged releases start at `1.0.0`.

## Compatibility from 1.0

| Part | Changes | Installation |
| --- | --- | --- |
| Patch (`1.2.Z`) | Fixes only; no migrations and no newly required setting. | Applies nightly, with automatic rollback on a failed health check. |
| Minor (`1.Y.0`) | Features, optional settings, and expand-only migrations. | The owner updates after reading the upgrade notes. |
| Major (`X.0.0`) | Anything requiring owner action: a removed or newly required setting, a PostgreSQL major, or stored data older code cannot read. | Follow the release's manual upgrade and recovery instructions. |

Before 1.0 there is no compatibility promise. From 1.0, each release's schema and
stored data must run the previous minor's code. Migrations expand first and remove
old shapes only after that compatibility window.

The migration check (`scripts/release/check-migrations.mjs`) keeps existing migration
files byte-for-byte unchanged and the journal append-only. It also checks the full
head journal's `when` timestamps are strictly increasing in entry order, whatever
commit range is checked. Equal or older timestamps fail with both migration tags
and an instruction to regenerate the migration, so existing installs won't skip it.

Stored job payloads, inbox events and settings JSON tolerate unknown keys, so the
previous minor reads what a newer one wrote: the gym's address, branding, website
content, pending backup change and backup destination, and its encrypted SMTP and
Google settings. Requests and provider input stay strict, and so does the write path
of a stored value. A save must not lose what it can't read. Where a form's save
replaces a value that only partly came from the form, it keeps the unknown keys
(address, branding, website content); SMTP and Google saves replace the whole value
with what the owner typed. A job with a name the running version doesn't know stays
queued until a version that knows it starts.

Other JSON columns are still read strictly: household addresses, emergency contacts,
and rank sub-ranks and criteria. A minor can't add a key to those.

A major release that cannot preserve this promise declares that in its upgrade
notes and sets its rollback floor to itself, which is what `pnpm release` proposes for
every major; one that keeps the promise passes `--rollback-floor` with the `.0` of the
previous release's minor. A minor can't exclude the previous release. Its default floor
is that same `.0`, so 1.5.0 after 1.2.3 has the floor 1.2.0, and a floor never names a
release that doesn't exist. A patch keeps its minor's floor. The release workflow starts
the previous published minor's image on the database migrated by the new image and
runs that previous release's own production smoke checks and deployment fixtures before publication. With no earlier release, it
prints a notice and skips that check. A declared major boundary also prints a notice.

The same test doesn't wait for a release. When a commit changes the migrations, Image
checks builds the newest release's code (before the first release, the code the
branch started from) and runs that code's own production smoke checks on the schema the commit
migrated. It prints a notice and skips when no migration changed, when the rollback
floor declares a boundary above that release, or when that code predates this promise.
In compatibility runs, the smoke test accepts additional public tables from newer
migrations; ordinary image smoke runs still require the exact expected count.
Both checks identify the smoke script's source revision and the image being tested,
including in failures. Image removal has a 120-second limit; failure or timeout warns
without replacing the check's result, and temporary worktree cleanup still runs.

Older code starts on a newer schema because its startup catalog check accepts a table
it doesn't declare when the table has the security shape every table has: owner
`maintenance`, row-level security enabled and forced, exactly the gym policy or one
system access kind's policies, for the `app` role only, and no privilege beyond
select, insert, update and delete. Any other unknown table stops the start, and so
does a missing table or any change to a table that release declares. A minor can
therefore add a table or a column, but tightening a table the previous minor declares
(a new policy, a revoked privilege) breaks the promise and needs a major.

## Build identity

`scripts/release/version.mjs` reads Git before building. A clean release tag yields
`1.2.0`; fourteen commits later it yields `1.2.0+14.gabc1234`. Local changes append
`.dirty`. With no reachable release tag, including a clone without tags, it yields
`<package version>+0.g<sha>`. Outside a Git repository, such as a source archive, it
yields `<package version>+unknown` with the commit `unknown`; setting only one of
`APP_BUILD_VERSION` and `APP_BUILD_REVISION` is an error. CI checkouts calculating
this identity fetch full history and tags. Server and browser bundles embed the same
version and full commit. An empty `APP_VERSION` or `APP_REVISION` at runtime falls
back to the embedded value.

`/healthz` returns `status`, `version`, and `commit` without caching. The health page
and Settings → Updates show the version and short commit; OpenAPI's `info.version`
contains the same version. The shared browser navigation guard covers admin, portal,
and kiosk: it checks at most once a minute, waits at most a second, and on a changed
version or commit loads the destination of the navigation instead of the page being
left. Preloads and the development server don't check, and a failed check leaves
navigation alone.
The portal service worker does not cache application pages or API responses.

Versions with `+` build metadata are development builds. The release checker and
nightly updater never offer them updates. Docker tags cannot contain `+`; local
image tags replace that character, while the image label and app retain the full
version. Use `node scripts/release/build-image.mjs [IMAGE]` for a local image.

## Maintainer release command

Run `pnpm release` for a proposed version, or `pnpm release 1.0.0` for the first
public release. A breaking commit proposes a major, a feature or migration proposes
at least a minor, and other changes propose a patch. An explicit version cannot be
lower than that proposal, and a patch cannot include migrations. With nothing new,
the command does nothing.

Before editing files it requires a clean tree, `main` for a minor/major or
`release/X.Y` for a patch, equality with origin after fetching, successful **CI**,
**Repo compliance**, and **Image checks** runs for that exact commit, and configured
tag signing (`user.signingkey`, or SSH signing with `gpg.format=ssh`). A workflow whose
path filters skipped the commit (**CI** skips a Markdown-only one) counts from the
nearest earlier commit it ran on, since the previous release, when it would have
skipped every commit in between too. GitHub queries name the repository explicitly.
A fork can set `git config plaingym.repository OWNER/REPO`.

For a patch, first get that exact commit checked on an `integration/**` branch,
then fast-forward and push `release/X.Y` to it. The CI workflows run on integration
branches and `main`; pushing a release branch alone does not run those checks.

The command opens release notes in Git's configured editor. Review the summary,
migrations, rollback floor and manual host-file steps. The first release needs a
short summary written by the maintainer; an empty summary is refused. For an
existing notes file, use `--notes-file FILE`; `--rollback-floor X.Y.Z` explicitly
sets a compatible boundary. Anything written under **Unreleased** starts the notes
(a notes file that doesn't already contain it gets it added), because the release
leaves that section empty. Notes become a dated section of `CHANGELOG.md` under
**Unreleased**, ordered by version.

The command bumps all five manifests in `chore(release): vX.Y.Z`, creates a signed
annotated tag with `git tag -s`, and never pushes. The signer runs with the terminal
attached, so it can ask for the signing key's passphrase. The command then reads the
tag back: when it carries no SSH or PGP signature (Git can exit successfully with an
unsigned tag when the signer couldn't run), it deletes the tag and the release commit
and stops, so fix the signing setup and run it again. A patch also adds the same section
to `main` in `docs: changelog for vX.Y.Z`, without changing `main`'s package versions.
Its main checkout must be clean and level with origin too. Review both branches and
the tag, then push the refs printed by the command. The Release workflow takes its
GitHub release notes from that exact changelog section.

See [updating.md](updating.md) for owner updates and rollback, and
[deploy/README.md](../deploy/README.md#releases) for manifests and release infrastructure.
