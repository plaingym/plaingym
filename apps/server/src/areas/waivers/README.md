<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Waivers and agreements

User-facing validation and conflict messages use `locales/en/waivers/validation.json` through `messages.ts`.

`createWaiversService({ uploadsFor, documentDelivery?, clock?, scope? })` manages versioned templates,
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
Text copies put SHA-256 of those exact stored bytes on every page. Uploaded PDF
copies retain the original pages without stamps and append the generated signing
details and snapshot SHA-256 footer.
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
Text chunks (`tEXt`, `zTXt`, `iTXt`) are limited to 8 KiB each and animated PNGs
(`acTL`, `fcTL`, `fdAT`) are refused, because the PDF renderer's PNG reader reads both.
Signing checks the image digest, then rechecks member/template state in
a short transaction. Storage and rendering occur outside transactions. Retrying
the same image and signing details returns the original signature; reusing that
image with different details conflicts.

Demo signing admits validated signature PNGs through a dedicated waiver operation;
general visitor uploads remain disabled. Before storage, each upload reserves an
audited admission under the gym row lock. A sandbox allows 64 signature-image
admissions over its lifetime (at most 16 MiB of PNG data), shared across members
and app processes. Invalid or unauthorized requests consume none; failed or
abandoned writes retain their admission until sandbox deletion. This keeps retries
and concurrent requests bounded without holding a transaction open over storage.
Normal installs have no demo admission cap.

Downloads expire after five minutes. Rendered PDFs are tombstoned immediately
for the normal deferred storage sweep, so generated copies do not accumulate
indefinitely. Existing signed URLs remain usable until expiry. Signature images
are marked for deletion by the member-erasure service. Abandoned unsigned image
uploads are not yet swept by this area; cleanup should retain referenced images.

Demo downloads reuse one immutable PDF keyed by the signature image, keeping the
same JSON response and five-minute signed URLs. The demo upload wrapper refuses
all ordinary puts; its waiver cache can create that copy. Concurrent requests
share a render, and later requests (including after a restart) only read storage.
If the cached PDF upload failed and left no stored copy, each download falls back
to a fresh copy marked deleted right away. This costs up to about seven storage
writes per download, still bounded by ten downloads per gym per minute.
The cache stays until image erasure also tombstones its PDF, or sandbox cleanup
removes the gym. Erasure during rendering prevents a fresh link and tombstones any
copy written in the meantime. Production downloads still render and tombstone a
new copy each time. The PDF route allows ten demo requests per gym per minute
across all client addresses, before storage reads or rendering. This uses the
process-local route limiter; deployments with several app processes need a shared
limit to retain the same total budget.

## Composition

`document-delivery.ts` exports `createWaiverDocumentDelivery({ key, originFor,
uploadsFor, clock? })`. Pass that service as `documentDelivery` when composing
waivers. The key must be stable across processes and restarts and derived for this
purpose; origins must be the gym's canonical HTTP(S) origin. The area registrations
mount its download route. Without this option, document uploads and publication
are unavailable; text templates continue to work.

The app composition must also pass `bodyLimits` with `defaultBodyLimits` and its
route entries preserved, adding `/api/waivers/template-documents` with
`documentByteLimit` from `infra/pdf/document.ts` (10 MiB); `core/runtime.ts` does
both. Without it the app's default 1 MiB cap would reject larger documents before
the waiver handler. Like other
large uploads, this route requires a valid `Content-Length` and refuses transfer
encoding before reading the body.

`core/runtime.ts` calls `configureWaivers({ uploadsFor: uploads.forGym, clock,
documentDelivery })` (the delivery key is derived from the install's encryption key)
before serving the existing area registrations. The prewired waiver routes and web
registrations need no barrel changes. Admin templates use `settings.manage`;
signing/signature uploads use `members.manage`; reads and PDFs use `members.read`.
These are staff routes, not portal or signed-link routes.

Template versions contain exactly one of nonblank `body` or a document reference
(`key`, SHA-256, pages and bytes). The database stores PDF versions with an empty
body and nullable document columns protected by an exclusivity check. Snapshots
include the immutable document reference; older snapshots omit it and still read.
The renderer's vendor boundary is documented in `../../infra/pdf/README.md`.

## Uploaded template documents

Staff with `settings.manage` upload raw `application/pdf` to
`POST /api/waivers/template-documents`, then use the returned reference when
creating or publishing a version. A version can switch between text and PDF.
Documents are limited to 10 MiB and 20 pages, validated before storage under a new
immutable `${gymId}/waivers/templates/<uuid>.pdf` key, and never logged. The demo
refuses these uploads with its existing uploads-disabled message.
Plain web, email and internal page links and a `GoTo` open action are accepted;
other annotations, actions, forms and embedded files are refused. Signed copies
verify the snapshot's document hash and size and retain bounded structural parsing,
without reapplying upload policy to a legal record. Document parsing and copying
allow one active job and eight waiting jobs, with at most two waiting per gym.
The slot is reserved before reading the stored document, after the signing page has
rendered; overload is a retryable `rate_limited` response (429 with the `busy` reason
and `Retry-After: 1`), distinct from a changed waiver. The staff screens show its
message, and the portal, signed-link, join and drop-in pages show their busy text
only for it; any other 429 (a rate limit, or a demo quota) says the limit is reached.

Staff document reads require `members.read`. Portal and signed-link reads check
the household credential and expose only current templates; public join and
drop-in reads also expose only current templates. Each returns a five-minute
gym-bound capability URL. Both disk and S3 documents are read through `Uploads`
and served by the app with `application/pdf`, `nosniff`, no caching, and a sandboxed
CSP permitting same-origin framing. Every signing surface offers a native inline
frame and an always-visible **Open the document** link before consent. Family forms
preview each template once, keeping separate consent for each member. Readers must
open and read the document before confirming; an unavailable preview is not consent.
React previews retain their initial URL while the separate link refreshes, so a
refresh or a failed background request does not reset the reader's page.
URL issuance checks storage metadata; serving the PDF verifies its full bytes. It is
streamed: the first read of a document checks its digest without keeping the bytes
(concurrent first reads share that check), and every read is checked again as it
streams, withholding the last chunk unless the digest still matches.
Document URL reads and template downloads have separate 300-per-minute limits per
client and gym, allowing families sharing a Wi-Fi address to read multiple documents.
Refused frames and explicit opens show a plain retry page, including `Retry-After`
on a 429; JSON URL requests keep the API error response. Signed-link pages preview
only unsigned templates. Uploads have a separate ten-per-minute gym budget, independent of reads and
the demo's signed-copy budget. Invalid tokens cannot exhaust another client's budget.

Upload validation rejects malformed or encrypted documents, active actions,
attachments, forms, non-link annotations, alternate appearances, external-file references and optional-content layers. Flatten unsupported annotations before uploading. Ambiguous
incremental revisions and excessively complex object graphs are refused; save
a flattened new PDF in those cases. Single-revision Word hybrid files, linearized
files and predicted cross-reference streams are supported. Signing and rendering verify the original
document's bytes and hash. Retiring a family or publishing a new version never
deletes its original document. Abandoned uploads, like abandoned signature
images, are not swept by this area; cleanup must keep every document a version
or signature references. Waiver template exports include `document_key`,
`document_hash`, `document_pages` and `document_bytes`, including retired versions.

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
