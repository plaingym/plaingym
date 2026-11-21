<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Running a demo

A demo lets people try PlainGym without an account of their own. Its entry host's
root is a server-rendered product page. **Try the demo** opens a shared, read-only
showcase with sample data and one-click owner, coach and student logins. The
button is disabled while the showcase starts, and a note asks visitors to
reload. The next link opens the repository configured for the install. Old
entry-host `/demo` links redirect to the product page. Choose **Make my own copy**
to edit a private sandbox. If you reach the per-network hourly limit, the
button shows how many minutes to wait.
Copies expire after two idle hours and at most 24 hours after allocation.
Each private copy keeps its start page at `/demo`, ending with the current deletion
time and a reminder that using the copy moves that time later, up to 24 hours
after it was created. The read-only showcase has no deletion notice. The product
page explains the private copy's lifetime without showing a specific deletion time.
Its ten feature sections include seeded screenshots in both color schemes and
densities, with native popovers and full-size links. All assets come from the entry
host; the page runs no JavaScript. To refresh images, see the
[manual capture guide](../e2e/ux-pass/PRODUCT.md). Gym website roots and ordinary installs
keep their existing behavior.
Use a demo to evaluate the software, to train staff before launch, or to
show it to your board. Don't use it for your real gym: sandboxes are throwaway, and
demo mode is a separate kind of install.

If you only want to *try* the software, you don't need your own demo; if you want to
rehearse your own gym's setup instead, install normally ([install.md](install.md)) and
use a test Stripe key ([going-live.md](going-live.md#1-try-it-in-test-mode-optional)).

## What a sandbox is

* **A private gym when you edit**, at its own random hostname, seeded with sample
  households, a class schedule, promotion history and a student's portal.
  The website has a sample academy photo and logo, uploaded by the trusted seed.
  Its public pages stay off until an owner enables them in Gym details.
* **One-click logins** as owner, coach and student, and as the latest members who
  joined in the sandbox, on its start page (`/demo`) and in the **Demo menu**. A slim
  bar at the top of every page shows when the sandbox expires and opens the menu,
  which also goes to the start page, the admin, the member portal, the kiosk, the join
  page, the gym's website (when it's on) and the outbox. If you're signed out,
  **Gym admin** and **Demo outbox** sign you in as the owner, and **Member portal**
  signs you in as the student. If you're signed in, the links use your current
  session. The sample kiosk members check in by full name and PIN `2468`. The
  kiosk's name search shows one.
* **No outside effects.** Emails and texts are captured in an in-app **outbox** the owner
  and admins can read. On a private copy's `/login` page, **Open my sign-in link**
  opens the link sent to the address you entered after choosing **Email me a
  sign-in link**, without the owner. General uploads are off. A demo refuses to
  start with a live Stripe key.
  The sample gym has member texts enabled, with fictional consenting recipients
  and example texts in the outbox. SMS provider credentials are never consulted.
* **Test payments, optionally.** With a Stripe *test* key configured for the install
  (see below), `/join` takes payments with Stripe's test cards; without it, billing
  shows as not configured.
* **Idle expiry.** Copies expire after `DEMO_IDLE_HOURS` (default 2) without a
  request, at most 24 hours after allocation. Activity is persisted at most once
  every five minutes. Background discovery polls do not count as activity.
  Cleanup checks every five minutes.
* **Ready copies.** `DEMO_POOL_SIZE` (default 5) keeps gyms seeded ahead, one at
  a time. It must be at most `DEMO_MAX_SANDBOXES - 3`, leaving slots for the
  showcase, its replacement and a private copy. Empty-pool visitors see their
  place in line, including unfinished pool seeds ahead of them. The oldest live
  ticket receives the next ready pool gym; abandoned tickets expire after an hour
  and release their reservations. `DEMO_MAX_SANDBOXES` (default 50) includes the
  showcase, pool and queued reservations.

The showcase uses `showcase.<DEMO_DOMAIN>`, one level below the demo domain, and
is replaced 24 hours after promotion, remaining available until the replacement
is ready if capacity delays the swap. It refuses changes including kiosk check-ins, bookings, public
submissions, magic-link requests and signed links, and runs no gym jobs. Its
`/login` page offers one-click owner, coach and student sign-ins. Copies open
signed in as the selected seeded role on the same static page where possible.
Resource-detail URLs open the role's home because each seed has different resource IDs.

A demo needs a multi-gym install: `TENANCY=multi`, `DEMO_MODE=true`, a
`DEMO_DOMAIN` with wildcard DNS and TLS, and working S3-compatible storage (even
though visitors can't upload). The variables are in [configuration.md](configuration.md).

## Option 1: on your own computer

For looking around, or for developing. You need Node.js, pnpm and Docker; the
exact versions are in [development](development.md#local-development).

1. Follow "Local development" in [development](development.md) to create your `.env`, run `pnpm install`
   and `pnpm dev:up`.
2. Add the demo settings from ["Sandbox demo over local HTTPS"](development.md#sandbox-demo-over-local-https) on the same page
   (`TENANCY=multi`, `DEMO_MODE=true`, `DEMO_DOMAIN=demo.localhost`,
   `PUBLIC_ORIGIN=https://demo.localhost`, `AUTH_PASSWORD_LOGIN=off`) and the
   `UPLOADS_S3_*` values from `.env.example`.
3. Run `pnpm dev`, then in another terminal `pnpm dev:proxy:up` and `pnpm dev:proxy:trust`.
   Restart your browser once so it trusts the local certificate.
4. Open **https://demo.localhost/** and choose **Try the demo**.

The demo redirects to HTTPS on port 443, so nothing else on your computer can be
using that port. Stripe test payments are optional; the setup is in the
[demo mode notes](../apps/server/src/demo/README.md).

## Option 2: on a server

A one-command installer sets up a public demo on an Ubuntu server with wildcard TLS
through Cloudflare DNS. It asks for the demo domain, an ACME email, a Cloudflare DNS
token and your S3 bucket's details, checks them all before changing anything, and prints
the demo's address. The steps, the DNS records it needs, optional Stripe test
billing, and updating a demo are in [`deploy/demo/README.md`](../deploy/demo/README.md).

## A tour of the sandbox

1. On the start page, sign in as **Owner**: see the dashboard, **Members**, **Schedule**,
   **Ranks & promotions**, **Invoices** and **Settings**.
2. Sign in as **Student**: book a class, show the check-in code and look at the
   progress page ([member-portal.md](member-portal.md)).
3. Open the kiosk and check in a sample member by name and PIN `2468`.
4. If test billing is configured, follow the start page's join steps: join through
   `/join` with the test card number it shows (any future expiry and any CVC; no real
   money moves), then find the invoice as the owner.
5. As the owner, open the **Demo outbox** to read the emails the actions sent; the
   sign-in link for your new member portal is there. After that, sign in again as
   your new member from the start page or the **Demo menu**.

Throw the sandbox away when you are done: it expires by itself.
