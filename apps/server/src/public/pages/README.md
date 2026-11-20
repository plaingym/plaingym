<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Core public pages

In the shared demo showcase, intake writes return the demo read-only reason. The
join, trial and drop-in scripts offer a private copy, show its queue position and
open it through the destination-host one-time sign-in exchange. Ordinary gyms
keep their existing form behavior.

The shared shell on `/join`, `/trial` and `/drop-in` (including their status
pages) shows the gym's address, public phone and public email when configured.
The address comes from Settings → Gym details; phone and email come from
Settings → Website and remain public with the website switched off. Missing
channels are omitted; with no contact details, visitors see a short fallback.
Owner setup guidance lives in the admin Website section. `/api/public/config` includes these optional
fields in its gym branding projection; it never returns the rest of the website
settings. The join pages use the same projection.

Native join refusals before admission preserve typed details and show the original
field or service problems in a focused summary. After admission, a refusal asks the
visitor to contact the gym without submitting again; outages keep a 503 response
and unexpected faults go to the app's error handler. Join cleanup settles interrupted submissions that assigned
no memberships and reserved no discount uses without counting them as voids.
See [join.md](join.md) for the submission and cleanup rules.

`configurePublicPages` supplies the real waiver service, gym uploads, a staff
notifier and an optional `dropInFeeFor(gymId, tx)` projection: `createDropInFee()`
(`areas/settings/drop-in-fee.ts`) reads the gym's chosen drop-in charge type at its
current price on each page load, inside the config read's transaction (`tx`; a
provider must use it, since opening its own gym scope there fails as nested), and gives null (so the page asks visitors to contact
the gym) when none is chosen or the charge type is archived. `createPublicStaffNotices`
queues trial and drop-in staff notices: pass its `publish` as `notifyStaff` and give
its `send` to the `public.pages.staff_notice` job through `configurePublicStaffNotices`.
`publish` runs after the intake commits and enqueues only the kind and member ID,
keyed `public.<kind>.staff_notice:<memberId>`, so no visitor details reach the jobs
table. The job reads the intake when it runs (an erased one sends nothing), resolves
the gym's mail through `prepare(gymId)` (including the demo outbox), and mails
`accounts.staffEmails(gymId, ['owner', 'admin'])` one message each, never the
visitor. That fixed recipient list is what exempts the notice from the member-email
switch; any visitor confirmation must apply the switch. Each recipient has its own
durable send-state key (`infra/email/README.md`), so a retry reaches only staff a
definite non-send missed. The public pages hand `notifyStaff` identifiers only. These
core registrations work with every optional module disabled. Unconfigured services fail
closed. The public plan and join routes are separate contributions.

An ordinary install without SMTP skips staff mail while still recording intake:
`prepare` returns null and the job completes quietly. Publication or notification
failures are logged with the request ID and safe error metadata, never visitor
details; visitors still receive the same successful response after their record
commits.

`createRootRedirect` is core's `GET /`: it sends visitors to `/portal` unless the
gym has the website module on, when it hands the request on to the module's home
page (`modules/website/README.md`). It is mounted before every other route.

`publicLayout` is the Hono JSX shell for core pages. It escapes gym and document
text, uses `t()`, keeps `/source`, and serves only same-origin assets under a strict
CSP. The join, trial, drop-in, signed-link, staff invitation and sign-in email
confirmation pages follow the device's color scheme, as does the demo landing
page; a waiver's text body is part of the page and follows it. The public
website, uploaded waiver documents, emails, receipts and PDFs use a light palette.
CSS reuses the signed-link Tailwind asset. `/public/pages/theme.css` serves the
gym's validated brand color. In light mode it darkens pale colors as needed
for 3:1 contrast against white for primary fills and checked controls. In dark
mode it lightens the saved color as needed for 4.5:1 text contrast on both the
page and card backgrounds. Each mode picks a contrasting button foreground
for its rendered color. The saved brand color stays as configured.
Core public pages and signed links show the logo on a light tile.
Logos are streamed through the gym upload wrapper; foreign keys and SVG are refused.
Core pages address logos by a short hash of their immutable upload key, so unrelated
settings saves keep the same URL and replacing the logo changes it.
`/public/pages/logo/{version}` accepts only the current key's hash, and matching
images carry `Cache-Control: public, max-age=31536000, immutable`.
`publicBrowserScript` is standalone browser JavaScript, with no server bundler
helpers, hydration or build entry point. Native POST forms also work: signature PNG files
replace the canvas when JavaScript is unavailable.

Trials create an independent prospect and household and notify staff. Public
requests never look up or modify an existing household by email, link a login,
change a membership, or return member/account IDs. A matching email receives the
same status, body, headers and confirmation page as a new address. Staff reconcile
duplicate intake records after contacting the visitor.

Drop-ins first review every current template. `POST /drop-in/signatures` validates
the applicant, honeypot, template versions and bounded PNGs before creating a
prospect admission. It uploads each image through the waiver service (including
the persistent demo admission cap), returning only the image capabilities needed
by the public drop-in contract. These keys must remain private. The final
`POST /api/public/drop-in` accepts only images for that public intake, with exactly
matching applicant and contact details. It never signs for an enrolled household.
After every immutable waiver has been signed, the prospect becomes a visitor.
Replaying the same final request reuses the original signatures and visitor.
An admission stays open for 24 hours. The nightly `public.drop_in.cleanup` batch
job removes expired, unsigned, unchanged prospects, their households and automatic
new leads, and marks their signature images for the storage module's deferred
sweep. Storage runs outside transactions. A durable cleanup marker permits retry
after a storage failure; other admissions are still processed. Completed visits,
partially signed waivers and records changed or followed up by staff are kept,
including their images. An unsigned expired prospect cannot submit even before
cleanup runs. A partly signed prospect can finish after the window, including
after cleanup retains it, only with an already signed image from that admission
and the same applicant and contact details. An unsigned or unrelated staff image cannot extend
the window. Completed visits can still replay their final request. Admissions grant no portal
access or membership. No payment provider, invoice or card operation runs.
The fee is informational and is collected by staff as a one-off charge. If no fee
is configured, the page directs the visitor to ask the gym; it never assumes zero.
The price is the charge type's catalog price, followed by "+ tax" when a tax rate
attached to it is active, exclusive and above zero (`plusTax`); no total or tax amount is shown.

Submission and upload budgets are separate, each ten per gym/IP per fifteen
minutes, shared across JSON/native forms, enforced before validation. They are
counted in PostgreSQL by the trusted client address, with IPv6 grouped by /56;
IPv4 and mapped IPv4 retain their individual address. Every app process shares
one window and a restart keeps it (`core/rate-limit-store.ts`). Whole requests are limited
to 1 MiB, each image to 256 KiB, and a visit to eight templates. Responses containing
intake data use `no-store`.

New trial, drop-in and join admissions share per-gym ceilings of **10,000
participants and 1 GiB of decoded signature images per fixed UTC hour**, plus
**4 GiB of decoded signature images per local calendar day**. The daily window
resets at the gym's local midnight, including daylight saving changes. A family
join counts each participant; decoded images round up to KiB per admission so
the integer counters represent the full allowance. Typical drawn signatures need
much less space than the maximum-size PNGs. The daily limit bounds repeated
uploads before abandoned admissions are cleaned up; reaching it closes new image
admissions for that gym until its next local day. Trials without images can still
use the remaining participant allowance.

Join and drop-in reserve only after applicant, plan/readiness, template and image
validation (and join's signer and code validation), before record creation and
storage. One PostgreSQL transaction reserves participants and both byte windows;
a refusal rolls every increment back, leaving room for smaller requests and
trials. Failed work after reservation keeps its allowance until each window ends.
All processes and restarts share these counters. A ceiling refusal returns 429,
the page's busy-form text and `Retry-After` until the exhausted window ends, and
logs `public.intake.ceiling_reached` once per gym/resource/window per process,
with only identifiers and counts. A counter write failure returns 429 with the
short busy-retry text, `reason: busy` and `Retry-After: 1`; a database outage follows
normal error handling. Finishing an existing drop-in or join spends no new
admission/byte allowance, so a flood cannot close an admitted visitor's form.
Drop-in and join cleanup share the durable claim/storage/completion helper in
`admission.cleanup.ts`, resolving storage once per run and retaining staff work
under the same household/member locks as the eligibility checks.

Composition requires the runtime to call `configurePublicPages` with its existing
waivers, `uploads.forGym`, gym mail and staff recipients. The fee resolver should
read an explicitly selected charge type; there is no implicit name-based mapping.
That same call configures cleanup; the existing public area jobs register its
nightly batch schedule. No separate runtime registration is required.
The drop-in and join signature admission schemas and routes live in the shared
public contracts. The services still validate the decoded PNG and enforce the demo
signature allowance before storage.

`pages.test.ts` exercises real PostgreSQL and the production route registrations.
`mobile-check.mjs` renders the real pages and shared assets in Edge at 360 and
1280 px, checks touch targets and axe, and submits drawn and file signatures.
