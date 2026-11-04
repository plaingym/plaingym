<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Running a demo

A demo lets people try PlainGym without an account of their own: each visitor
creates a **sandbox gym** filled with sample members, classes, ranks and invoices,
signs in as its owner, coach or student with one click, and watches it disappear after
24 hours. Use a demo to evaluate the software, to train staff before launch, or to
show it to your board. Don't use it for your real gym: sandboxes are throwaway, and
demo mode is a separate kind of install.

If you only want to *try* the software, you don't need your own demo; if you want to
rehearse your own gym's setup instead, install normally ([install.md](install.md)) and
use a test Stripe key ([going-live.md](going-live.md#1-try-it-in-test-mode-optional)).

## What a sandbox is

* **A whole gym per visitor**, at its own random hostname, seeded with sample
  households, a class schedule, promotion history and a student's portal.
* **One-click logins** as owner, coach and student, on the sandbox's start page
  (`/demo`), plus the public join page and the check-in kiosk. The sample kiosk
  members check in by full name and PIN `2468`.
* **No outside effects.** Email is never sent; it lands in an in-app **outbox** the owner
  and admins can read. General uploads are off. A demo refuses to start with a
  live Stripe key.
* **Test payments, optionally.** With a Stripe *test* key configured for the install
  (see below), `/join` takes payments with Stripe's test cards; without it, billing
  shows as not configured.
* **Deleted after 24 hours.** The number of sandboxes at once is capped
  (`DEMO_MAX_SANDBOXES`, default 50).

A demo needs a multi-gym install: `TENANCY=multi`, `DEMO_MODE=true`, a
`DEMO_DOMAIN` with wildcard DNS and TLS, and working S3-compatible storage (even
though visitors can't upload). The variables are in [configuration.md](configuration.md).

## Option 1: on your own computer

For looking around, or for developing. You need Node.js, pnpm and Docker; the
exact versions are in the root [`README.md`](../README.md#local-development).

1. Follow "Local development" in the root README to create your `.env`, run `pnpm install`
   and `pnpm dev:up`.
2. Add the demo settings from "Sandbox demo over local HTTPS" in the same README
   (`TENANCY=multi`, `DEMO_MODE=true`, `DEMO_DOMAIN=demo.localhost`,
   `PUBLIC_ORIGIN=https://demo.localhost`, `AUTH_PASSWORD_LOGIN=off`) and the
   `UPLOADS_S3_*` values from `.env.example`.
3. Run `pnpm dev`, then in another terminal `pnpm dev:proxy:up` and `pnpm dev:proxy:trust`.
   Restart your browser once so it trusts the local certificate.
4. Open **https://demo.localhost/demo** and choose **Try the demo**.

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
   sign-in link for your new member portal is there.

Throw the sandbox away when you are done: it expires by itself.
