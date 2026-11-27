<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Going live with billing

A new install starts with **billing, member emails and member texts off**, so you can import
members, set up plans and check everything while your old system keeps running. A
restored install also starts with all three off. Shut down the old server before turning
any back on, and confirm it is gone in the backups section to release the
pruning hold ([restoring.md](restoring.md#what-to-check-afterwards)). This guide takes you from there to charging members. The three switches
are on **Settings → Go live**.

## What each switch does

| Switch | While off | When turned on |
| :--- | :--- | :--- |
| **Billing** | No new card charges: no automatic collection, no retries, no staff card charges, no pay links. Cash and check payments and refunds are still recorded. Payments already started at Stripe still finish. | The daily charge run collects what is due, retries failures and staff can charge cards. |
| **Member emails** | No receipts, payment reminders, card-expiry notices, campaign links or other emails to members. Staff invitations, sign-in links and security emails to owners continue. | Those emails go out. |
| **Member texts** | No member texts. Owner provider tests still work. | Texts require a saved provider, consent and a slot under the daily cap; see [turning on member texts](self-hosting.md#turning-on-member-texts). |

Turning billing off later pauses new charges at once; it is the emergency brake.

To offer bank payments on join, onboarding, payment-method update and invoice links,
turn on **Accept bank payments** under **Settings → Integrations → Payments**.
That switch turns bank payments on and off. Your Stripe account must have ACH
Direct Debit (USD) or Canadian pre-authorized debits (CAD) activated; after that,
the Dashboard's on/off setting for the method doesn't apply, because the app names
the payment methods on each Stripe Checkout page. If Stripe refuses the method, the
app offers cards only and Payments shows a warning. For CAD, keep **Send Canada PAD
mandate, debit initiation, and microdeposit verification emails** on under
**Settings → Business → Customer emails** in the Stripe Dashboard. A bank payment can take up to four
business days to settle in the US or seven in Canada. The first processing
payment starts the membership. A later failure enters the usual billing follow-up.

## 1. Try it in test mode (optional)

1. In the Stripe dashboard, create a **test-mode** restricted key with the permissions
   in [self-hosting.md](self-hosting.md#stripe) and paste it under **Settings →
   Integrations → Payments** (or in the wizard).
2. Add a plan, create a member and a membership, and switch **Billing** on. Use Stripe's
   test cards on a pay or card link to see a charge, a receipt and a failed payment.
   A new membership whose next billing date is today has no invoice yet: the first
   invoice appears when the daily charge run reaches its billing date. To test a
   payment now, use **Add one-off charge** on **Invoices** and pay its link.
3. Check the **System health** page: webhooks processed, charge runs, no failed jobs.
4. Switch **Billing** off again before the real members are in.

## 2. Prepare

Work down the **Readiness checklist** on **Settings → Go live**. Each line says
*Ready*, *Needs attention* or *Not applicable* and what to do:

| Item | What makes it ready |
| :--- | :--- |
| Gym details | The setup wizard is finished. |
| Members | Members are in the app ([importing.md](importing.md)). |
| Schedule | Your classes are added. |
| Payments | A Stripe key is configured. A test key counts too, so check that it is your **live** key (step 1 below). If it says Stripe could not be checked, the saved keys can't be read: check them in **Settings → Integrations → Payments**. Until then billing can't be switched on and Online joining stays *Needs attention*. |
| Saved cards | Every household with a paid membership has a usable default payment method ([card-recollection.md](card-recollection.md)). |
| Waivers | Active members have signed every current waiver. After a switch, send a **Sign waivers** campaign ([card-recollection.md](card-recollection.md#re-signing-waivers-after-a-switch)). |
| Online joining | Billing is on, Stripe is connected, one to eight waivers or agreements are current, and at least one active plan is priced in the gym's currency, so /join can take members. It stays *Needs attention* while billing is off, so it clears only when you switch billing on in §3. |
| Email delivery | Email is set up and a test message arrived. |
| Backups | Backups are set up and the key is stored safely. |
| Payment notifications | At least one Stripe notification was processed, and none are waiting or failed. |
| Payment reconciliation | No unresolved payment attempts; after a [restore](restoring.md), the restored payments have been checked in the current Stripe mode. Without a Stripe key it is not applicable when there is nothing to check; a check made before Stripe was connected or in another mode must be run again. |
| Past billing dates | No active membership has a next billing date before today. The memberships that do are listed below the checklist. |

Only *Payment reconciliation* after a restore blocks billing, and past billing dates
must be confirmed when you turn billing on; the others advise you. Treat them all as
required for a real launch.

After a restore, Go live says whether the last payment check ran without Stripe;
its count then means stored references, not objects read from Stripe. Connecting
Stripe after that check, or switching to a mode the check did not read, pauses
billing, even if you already turned it on. A test-mode check does not clear live
payments. Re-saving the same checked mode keeps billing on. In
**Go live**, choose **Check restored payments again**, resolve any issues, and turn
billing back on once the check is clear. After a check without Stripe, the Payments
section also explains this pause. After a mode switch, Go live and Payments name
the earlier check's mode and ask you to check again in the saved mode before
turning billing back on. Go live keeps the earlier check's counts visible, but
*Payment reconciliation* needs attention until you check again.

Then:

1. **Switch to the live Stripe key.** Paste the live key (`rk_live_…`). The page lists what
   switching clears (test customers, saved test cards, open payment pages, open test
   disputes) and what stays; confirm it. Test payments stay on their invoices, marked "Stripe test mode", and
   any open disputes on them are closed (they stay in Stripe's test mode).
   After a restore, run **Check restored payments again** with the live key before
   turning billing back on, even if the test-mode check was clear.
2. **Check backups.** The **System health** page should show a recent successful backup
   under the current key at the current destination. After changing either, wait
   for the first matching snapshot. Setup and Settings check that the destination
   credentials can list, write, read and delete a probe under `blobs/`, where
   snapshots write, before generating a key. Credentials or a bucket policy may
   be limited to the `snapshots/` and `blobs/` prefixes.
3. **Check past billing dates.** Memberships whose next due date has already passed will
   be invoiced for each missed period once billing is on. Reconcile them against your
   old system now ([importing.md](importing.md#memberships-columns)).
4. **Collect payment methods and turn member emails on** ([card-recollection.md](card-recollection.md)).
   Tell members first: what the new emails are, and that their old system stops
   charging them on a date you name. Campaign links are only sent while member emails
   are on.
5. **Check the Stripe webhook.** The Payments section should show the endpoint as
   registered. The *Payment notifications* item needs a processed event: the first
   payment method a member saves through a campaign link gives it one.

Mail from a new sending domain often lands in spam at first, even when it is set up
correctly. Send yourself a test, open the message's **Show original** (Gmail; other
providers have a similar view), check that SPF, DKIM and DMARC say PASS, and mark
early messages **Not spam**.

## 3. Switch over

1. In your old system, stop its automatic charging **after its last run you want to
   keep**. Never run both for the same membership: members would be charged twice.
2. On **Settings → Go live**, turn **Billing** on.
3. If any active memberships are past due, the page lists each one (member, plan, due
   date) and asks you to tick a confirmation. The turn-on only goes through if those
   memberships and dates are unchanged since the list was shown; if something
   changed, reload and review again.
4. Confirm. The next daily charge run collects each membership due, in the gym's
   timezone, at its due date and amount. Dates up to seven days overdue are charged
   on that run; older ones are held for your review.

The local card minimum check assumes the gym's currency is its Stripe account's
settlement currency. If Stripe converts the charge, its settlement-currency minimum
still applies and Stripe decides whether the converted amount meets it. Invoices
below the local minimum or off the currency's charge step need a manual payment;
pay links, the portal and online joining explain this instead of opening Checkout.

## 4. Watch the first cycle

* **System health** shows the last charge run, failed jobs, Stripe webhook status and
  any failures. Open it daily for the first week.
* **Invoices** shows each invoice and its payment state. A failed card payment keeps
  the invoice open, emails the payer a link to pay or update their card (while member
  emails are on) and is retried on a schedule; a payment that needs the cardholder to
  confirm (for example a bank's 3-D Secure step) is sent as a link too.
* Record cash and check payments on the invoice. Refund from the invoice; a payment
  marked "Stripe test mode" can't be refunded.
* Replaying a missed Stripe event: `sudo docker compose exec -T app gym-app replay
  --gym <gym-id> <event-id>` ([self-hosting.md](self-hosting.md#day-to-day)).

## Turning billing off again

Switch **Billing** off on the same page. Charges stop being created; accounting for
payments already in progress, cash and check records, and refunds continue. Turn it back
on after fixing the problem; the past-due confirmation applies again if any dates have
passed.
