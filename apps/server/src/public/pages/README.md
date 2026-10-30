<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Core public pages

`configurePublicPages` supplies the real waiver service, gym uploads, a staff
notifier and an optional `dropInFeeFor(gymId)` projection. `createPublicStaffNotices`
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
definite non-send missed. `createPublicStaffNotifier` sends the same notice during the
request to staff addresses its `prepare` returns, for compositions not yet using the
queue. These core
registrations work with every optional module disabled. Unconfigured services fail
closed. The public plan and join routes are separate contributions.

An ordinary install without SMTP skips staff mail while still recording intake:
`prepare` returns null and the job completes quietly. Publication or notification
failures are logged with the request ID and safe error metadata, never visitor
details; visitors still receive the same successful response after their record
commits.

`publicLayout` is the Hono JSX shell for core pages. It escapes gym and document
text, uses `t()`, keeps `/source`, and serves only same-origin assets under a strict
CSP. CSS reuses the existing signed-link Tailwind asset, with validated gym color
tokens in an external stylesheet. The color's foreground is chosen for contrast.
Logos are streamed through the gym upload wrapper; foreign keys and SVG are refused.
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
Failed or abandoned admissions remain prospects for staff review; they grant no
portal access or membership. No payment provider, invoice or card operation runs.
The fee is informational and is collected by staff as a one-off charge. If no fee
is configured, the page directs the visitor to ask the gym; it never assumes zero.

Submission and upload budgets are separate, each ten per gym/IP per fifteen
minutes, shared across JSON/native forms, enforced before validation. They use the
core process-local limiter and trusted client address; multi-process installations
need a shared perimeter limit for an aggregate budget. Whole requests are limited
to 1 MiB, each image to 256 KiB, and a visit to eight templates. Responses containing
intake data use `no-store`.

Composition requires the runtime to call `configurePublicPages` with its existing
waivers, `uploads.forGym`, gym mail and staff recipients. The fee resolver should
read an explicitly selected charge type; there is no implicit name-based mapping.
The signature admission schema is local pending addition to shared contracts.

`pages.test.ts` exercises real PostgreSQL and the production route registrations.
`mobile-check.mjs` renders the real pages and shared assets in Edge at 360 and
1280 px, checks touch targets and axe, and submits drawn and file signatures.
