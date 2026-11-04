<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Card re-collection guide

Cards can't be copied between payment systems, so after you import members from
another system each paying household needs to save a card with you once. This guide
sends them a link that does it. Members enter card details only on Stripe's hosted
pages; PlainGym stores a Stripe reference, never the card number.

This is done **before** you turn billing on: saving a card charges nothing.

## Before you start

* **Stripe is connected with your live key.** Cards saved while the gym uses a test
  key (`rk_test_…`) are cleared when you switch to the live key
  ([self-hosting.md](self-hosting.md#after-setup)), so collect real cards only after
  the live key is in **Settings → Email, payments and backups**.
* **Members and memberships are imported** ([importing.md](importing.md)), so each
  household has its membership and an email address. A household without an email
  is shown as "No household email" and can't be sent a link; add the email on its
  profile, or collect that card in person (below).
* **Member emails are on.** Campaign links go out only while **Member emails** is on
  under **Settings → Go live**. That switch is separate from **Billing**, which stays
  off. It also lets receipts, reminders and signed links be sent, so check your
  email delivery first (the checklist's *Email delivery* item).
* **Waivers are ready**, if you will use the *Onboarding* purpose: it asks the
  household to sign every current waiver as well as saving a card.

## Send the links

1. Open **Campaigns** (`/admin/campaigns`) and choose **New campaign**.
2. Name it, and choose the **Purpose**:
   * **Update card** asks only for a saved card.
   * **Onboarding** asks the household to sign the current waivers and save a card.
3. Set **Links expire** (a date within 90 days; links end at the close of that day in
   your gym's timezone) and, optionally, **Reminder days**: up to ten increasing days
   after creation, separated by commas (for example `3, 7`). Reminders go out within the
   hour after 9 am gym time to households that haven't finished. Leave it blank for
   none.
4. Pick the **Households**. **Find households** searches by name. The **Needs a card**
   filter keeps only households with no saved card; **Select matching households**
   adds everyone visible. Selections survive changing the filter. A campaign takes
   up to 2,000 households.
5. Choose **Create and send**. The first emails are queued straight away.

Each household gets one private link, good for one household only. Opening it
leads to Stripe's page to save a card. A household that is new to Stripe gets a
Stripe customer then.

## Follow up

Open the campaign to see how many links are **Pending**, **Completed**, **Expired**
or **Revoked**. **Who's left?** lists the households that haven't finished, and
**Remind pending households** sends them another email now. A link counts as
completed when Stripe reports the card saved, even if the member closed the tab
straight after.

Each link is emailed at most once a gym-local day, scheduled and manual reminders
together, and the link's expiry never moves. A reminder replaces the earlier link in
the member's inbox: if the member says it doesn't work, use the newest email.

Back on **Settings → Go live**, the *Saved cards* item turns *Ready* when every
household with a paid membership has a saved default card. Chase the rest by
reminder, by phone, or in person.

## Households that don't respond

A payer who is signed in to the member portal can save or change their card on
**Billing** (`/portal/billing`), which opens the same Stripe page; see
[member-portal.md](member-portal.md). For a household that ignores email, create a
small **Update card** campaign for just that household after fixing its email
address, or invite its payer to the portal.

## Cards already in your Stripe account

If your old system used **your own Stripe account** (the one connected here), the
cards may already exist:

* Map **Stripe customer ID** and **Stripe payment method ID** columns in the people
  import ([importing.md](importing.md)). Imported IDs are kept as given, and a
  household with an imported card counts as having one.
* Without those columns, customers created by another system are **not** matched by
  email, even when the address is identical, and their cards aren't reused. Only
  customers PlainGym itself tagged for your gym are matched. Opening a link then
  creates a new customer.

## Afterwards

* A card whose expiry month has passed makes the *Saved cards* check show *Needs
  attention*, and members get card-expiry emails while member emails are on.
* A household can replace its card any time from the portal, or from a new
  **Update card** campaign.
* Go on to [going-live.md](going-live.md).
