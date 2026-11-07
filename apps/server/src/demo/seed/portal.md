<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Demo portal seed

`portalSeed(options)` runs last, after the mat seed. It fills in the sandbox's
one-click student, Alex Student of the "Demo student" household, which the demo
identities create with its payer login. A gym without that household (the seed
command on an ordinary gym) is left alone. Every change goes through the same
services staff and members use; the seed writes no booking, attendance, rank,
code or invoice rows itself.

* **Kiosk PIN and birth date.** The household gets the shared sample PIN (2468)
  and the student an adult birth date, so they can sign their own waiver.
* **Waiver.** The student signs the current "Demo participation waiver" through
  the trusted seed uploads, which take none of the sandbox's visitor signature
  admissions. With it, the kiosk's standing checks pass.
* **QR check-in code.** Issued once through the check-in code service with the
  gym's encrypted key, so the portal shows a code the sandbox kiosk accepts.
* **Rank progress.** Three white-belt promotions (240, 160 and 80 days ago) and
  two kiosk visits a week over the last four weeks. The latest stripe has met its
  time requirement; 8 of its 12 classes are done.
* **Bookings.** The student's own login books the next two reservable classes
  that start at least three hours after seeding, ahead of the cancellation cutoff.
* **Waitlist.** The first upcoming Competition Training that the mat seed left
  scheduled gets a capacity of three. Staff book the competition team (Marcus
  Rivera, Aisha Khan, Tobi Adeyemi) into it, and the student takes the first
  waitlist place. Cancelling one of those bookings promotes the student.
* **Invoices.** With the shared Stripe test account, the student gets a customer,
  a test card and an adult monthly membership. The runner's cycle generator
  issues three monthly periods: the two older ones are paid in cash and the
  current one is charged to the card, as for the sample households. The billing
  switch is turned on and left on, so the sandbox's `/join` takes payment.

Without the test account the student gets everything except invoices, and billing
stays off, so `/join` shows that online joining is unavailable.

## Reruns

Each part tops up what is missing, so a retry finishes a run that failed partway:
the PIN, signature and code are added once, promotions by rank and sub-rank,
visits up to eight, booked classes up to two, and the waitlist until the student
holds a place. A rerun on a later day adds nothing once they are in place. While
the student has no waitlist place, a missing upcoming Competition Training, coach
or competition team member fails the step; it never shrinks another class instead.
If signing failed after uploading the sample PNG, the retry reuses that unsigned
image after checking its contents. Deleted images and images already used to sign
another template are excluded.

Billing shares the billing seed's helpers (`billingSeedState`, `seedCalendar`,
`seedTestCard`, `settleSeedPeriods`) and its gym-wide calendar anchor, including
when the portal step runs across local midnight. A card
reservation blocks a blind retry after 23 hours, and the student's history must
end paid. A rerun after a failed current charge uses the current injected time.
When the next unused retry window has arrived it retries through the runner;
before that deadline it makes an explicit staff charge attributed to the
sandbox's owner. Neither path advances the clock into the future. Abandoned
creates leave retry windows unused, and paid periods are left alone. Pending or
unknown outcomes and exhausted retry schedules still need reconciliation.
If the step fails, it restores the billing switch it found (a restore that
fails too is logged as `demo.portal.billing_restore_failed`, and the step's own error is
the one reported); a completed
run leaves the switch to the gym, even if the owner has turned billing off since.

## The full demo

A fresh sandbox opens on `/demo`. From there a visitor signs in as owner, coach
or student, joins through `/join` with the test card `4242 4242 4242 4242`, and
opens the kiosk. The join activates only from the shared webhook
(`checkout.session.completed`, routed to the sandbox by the Checkout session's
`gym_id` metadata). Its passwordless sign-in link goes to the sandbox's outbox,
which the owner reads; following it lands the visitor in the new household's
portal (afterwards the start page and the **Demo menu** offer the new member by name,
and `/login` opens the visitor's own sign-in link from the outbox), where they issue a check-in code and scan it at the kiosk. Each drawn
join signature takes one of the sandbox's 64 signature-image admissions; once
they are used, `POST /join/signatures` answers 429.

## Checks

`portal.test.ts` seeds a real sandbox in real PostgreSQL with FakePayments: the
student's data and reruns on a later day. It also routes a signed payment-mode
`checkout.session.completed` through the install endpoint with the real Stripe
adapter, offline. `portal.isolation.test.ts` checks that a second sandbox has its
own student and QR key. `portal.reruns.test.ts` covers the seed without a test
account, a failed run's resume and a missing waitlist class;
`portal.reruns.billing.test.ts` and `portal.reruns.failure.test.ts` cover the
billing switch restore and the reported failure. Each of these four files seeds
one sandbox before its tests and gives each test a copy of it.
`portal.leftovers.test.ts` uses the same fixture pattern for the current-charge
retry, unsigned-image reuse and shared anchor across midnight. `portal.retry.test.ts`
covers reconciliation after a lost retry response and abandoned creates in retry windows.
`portal.runtime.test.ts` starts the
production runtime in demo mode and walks the full demo through its HTTP routes:
the student's portal and QR check-in, a join activated by the install webhook, the
outbox sign-in link and a new QR code at the kiosk; `portal.runtime.limit.test.ts`
checks the signature-image limit. Each file seeds its own sandboxes, so they stay
well under a minute when the whole suite runs together.

With the separate `e2e` dependencies installed and Edge available,
`node apps/web/src/features/demo/landing.browser-check.mjs` checks the sandbox
start page, the slim demo bar and the demo menu (a bottom sheet at 360 px, a side
panel at 1280 px) at both widths (no horizontal scroll, 44 px targets, axe WCAG
A/AA).
