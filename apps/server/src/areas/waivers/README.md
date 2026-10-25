<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Waivers and agreements

`createWaiversService({ uploadsFor, clock?, scope? })` manages versioned templates,
signature uploads, signing, signed-copy reads and PDF downloads. All changes are
audited without copying names, document text, IP addresses or signature bytes into
the audit log. The image is stored through `Uploads`, never in the database.

Template names identify families. Version one is their permanent lock anchor;
publishing appends a version after checking `expectedVersion`. Retirement marks
only the latest version. Lists select the latest version before filtering, so an
old version cannot reappear. Name and kind cannot change within a family.
Create and publish reject unsupported template characters with their visible
characters and Unicode numbers. They trial the actual PDF layout and size bounds,
reserving two pages for signing details, before storing a template version.

Signing locks the member against erasure and the template family against edits.
The complete snapshot is stored as serialized `text` and hashed as UTF-8.
No signature update path exists; the database also denies updates. PDFs verify
the stored bytes and image digest and never read the live template or member.
They put SHA-256 of those exact stored bytes on every page.
Signing preflights the complete snapshot outside a transaction, then locks and
rechecks the member, current template and idempotency key before insertion. A
failed render or a change during preflight leaves no new signature. Missing
glyphs in member/signer names render as visible replacements; they do not prevent
signing. The stored names and hash are unchanged.

Members under 18 on the gym's local signing date require a named guardian and
relationship. An unknown birthday also requires a guardian. An agreement can
capture `commitmentEndsOn`, an optional local calendar date, in the snapshot;
this records the agreement and does not mutate or enforce a membership term.

The image upload binds its immutable key to a gym and member. PNGs are capped at
256 KiB and 1200×600 pixels; headers, chunk CRCs and bounded decompression are
checked. Unknown ancillary chunks are skipped; unknown critical chunks fail.
Signing checks the image digest, then rechecks member/template state in
a short transaction. Storage and rendering occur outside transactions. Retrying
the same image and signing details returns the original signature; reusing that
image with different details conflicts.

Downloads expire after five minutes. Rendered PDFs are tombstoned immediately
for the normal deferred storage sweep, so generated copies do not accumulate
indefinitely. Existing signed URLs remain usable until expiry. Signature images
are marked for deletion by the member-erasure service. Abandoned unsigned image
uploads are not yet swept by this area; cleanup should retain referenced images.

## Composition

Call `configureWaivers({ uploadsFor: uploads.forGym })` from the runtime before
serving the existing area registrations. The prewired waiver routes and web
registrations need no barrel changes. Admin templates use `settings.manage`;
signing/uploads use `members.manage`; reads and PDFs use `members.read`.
These are staff routes, not portal or signed-link routes.

The approved shared-contract additions are `uploadSignature` and the optional
`commitmentEndsOn` request/snapshot field. No schema migration is needed.
The renderer's vendor boundary is documented in `../../infra/pdf/README.md`.

The web editor and signing form use the shared Dialog and mobile components.
Signed rows display the stored snapshot's template name/version, signer,
guardian relationship and signing time. Current-version status uses a scoped
signature query for each visible immutable template ID, independently of history
pagination. The member tab reads the gym timezone from the existing staff-readable
schedule options endpoint and formats dates in the active UI language (there is
no separate gym-locale field). Conflict messages and the demo's uploads-disabled
message are displayed; unexpected server errors retain a generic message.
`apps/web/src/features/waivers/mobile-check.mjs` checks 360 px and desktop
layouts against the isolated Vite `browser-fixture.html`, including modal flows,
44 px controls, no horizontal page scroll and axe WCAG A/AA. It requires the
existing e2e dependencies and the selected browser. Pass the Vite URL and then
`edge`, `firefox` or `webkit`; Edge is the default. It saves each browser's canvas
PNG alongside the screenshots for server validation. The fixture is not
imported by the application.
