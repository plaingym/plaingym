<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Member portal and booking guide

The member portal (`/portal`) is where members and parents book classes, show their
check-in code, see their progress, pay invoices, update their card and sign
waivers. It works in a phone browser and can be installed to the home screen. This
guide covers setting up what members book, inviting them, and what they see. Who can
see what is described in [security-model.md](security-model.md).

## 1. Set up what members can book

1. **Classes.** In **Schedule**, add weekly classes (*New weekly class*) and one-off
   sessions (*New one-off session*). A session with a **capacity** needs a booking:
   members book it in the portal, and when it is full they can join its waitlist.
   A session with no capacity needs no booking, and the portal shows "No booking needed".
2. **Booking rules.** In **Settings → Class and booking rules**, set:
   * **Booking window (days)**: how many calendar days before the class date booking
     opens, from midnight in your gym's timezone (`0` opens it on the day);
   * **Cancellation cutoff (minutes)**: how long before the start a member can still
     cancel or leave the waitlist. After it, the portal says to contact the gym.
3. **Waivers.** Create the documents members must sign under **Waivers and
   agreements**; members sign them in the portal (or when joining online).

## 2. Give members a login

A member gets in through a login linked to their household. Staff create the link
from the member's profile, on its **Portal access** tab:

1. Open **Members**, then the member (or the household's payer).
2. On **Portal access**, enter the **Login email** and choose the access:
   * **Whole household (payer)**: manages everyone in the household, sees invoices
     and cards, signs for children;
   * **This member only**: an adult sees only their own profile and bookings. It needs
     a date of birth showing the person is at least 18. Children use their payer's
     login.
3. Choose **Send email** or **Print private link** and select **Invite**. The invitation
   expires after seven days, and **Revoke invitation** stops its link working.
   Nobody has access until they accept it.

What the member sees when they accept depends on your email setup:

* **Gym has email:** accepting emails a sign-in link to the invited address; every
  later sign-in is by an emailed link.
* **No email set up:** accepting asks them for a password (12–128 characters). Staff can
  reset it from the same tab (**Reset password**).

When the gym has a Google OAuth client, from the install's configuration or entered by the owner ([configuration.md](configuration.md#google-sign-in)),
the portal's sign-in page also offers **Sign in with Google**. It signs in only an
existing login whose email is the Google account's address, once both addresses are
verified, so a member whose login has an unverified address (a password login on a
gym without email) still signs in by password.

When the gym signs in by password, a household that joins online through `/join` is
listed on the dashboard under **Households awaiting portal confirmation**, and its
**Portal access** tab shows **Awaiting portal confirmation**. A password login can't
prove who owns an email address, so check the person, then **Confirm and print
invitation**; they set their password from it.

Revoking a login (**Revoke access**) removes access at once, including an open
session. A person with logins to several households picks one when they sign in and
can switch from the portal header.

## 3. What members see

Members open `https://your-gym/portal` (or the root address, when the website
module is off) and sign in.

| Page | Who | What it does |
| :--- | :--- | :--- |
| **Schedule** | Everyone | One week of classes at a time. **Book**, or **Join the waitlist** once the booking window opens; **Cancel booking** or **Leave the waitlist** until the cutoff. A payer can book for each household member. |
| **Check-in** | Everyone | A QR code for the kiosk camera, per member. **Replace this code** if it was shared or a device was lost; the old code stops working at once. |
| **Progress** | Everyone | Current rank and what's next in each program, promotion history and attendance. |
| **Billing** | Payers | Invoices; **pay** an open one or **update the card** on Stripe's hosted page; receipts for paid invoices. |
| **Waivers** | Everyone | Documents waiting to be signed and signed copies as PDFs. A payer signs for children as their guardian. |
| **Household** | Payers (members read-only) | Contact details, and each person's profile and memberships. |

To install the portal, a member uses the browser's *Add to home screen* / *Install
app* option.

## How booking works

* A member who has held class credits needs an unexpired credit or an active or
  trial membership to book or join a waitlist in the portal. If neither is
  available, the portal refuses the booking; contact the front desk. Booking does not
  reserve or spend a credit. Staff can still book on the member's behalf.
  Members who have never held credits keep the existing booking rules.
* At the kiosk, a member who has held credits and has neither a usable credit nor
  an active or trial membership sees the neutral front-desk message. The kiosk
  shows no credit balance or reason; staff can inspect the standing reason.
* Booking a full class puts the member on the **waitlist** at a numbered position.
  A new booking never jumps the waitlist.
* When a place opens (a cancellation, or you raise the capacity), waitlisted members
  are promoted in order and told by email, if member emails are on. Promotion stops
  at the cancellation cutoff, so the waitlist is frozen near class time and a freed place
  stays open for walk-ins at the front desk.
* You can lower a class's capacity only to the number of people already booked.
* Booking and waitlist promotion are safe when many people act at once; the server
  re-checks capacity for each change.

## Check it works

1. Create a test household and invite yourself as its payer with an email you control
   that isn't a staff sign-in address: staff accounts can't be given portal logins.
2. Accept the invitation and sign in at `/portal`.
3. On **Schedule**, book a class inside the booking window, then cancel it before the
   cutoff. Try a full class to see the waitlist.
4. On **Check-in**, create a code, and scan it at the kiosk (`/kiosk`) or check in
   there by name and PIN. Register the kiosk device under **Settings → Kiosk devices**,
   then scan the setup code it shows, or open the setup link, on that device. They are
   shown once, and replace the device token stored in that browser. To update an
   already-open kiosk tab, paste the setup link into that tab's address bar.
   If the device has no camera, use name and PIN. Scanning a code or receiving a
   response restarts the idle period; unfinished QR selections reset after 60
   seconds without pointer or keyboard activity anywhere on the kiosk page.
   Completed results reset after eight seconds without activity. After a request
   error, **Try again** starts a fresh scan.
