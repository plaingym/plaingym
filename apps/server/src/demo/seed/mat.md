<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Demo seed: members and mat

`membersSeed()` (`members.ts`) and `matSeed()` (`mat.ts`) run after the foundation step, which
applies the sample content pack. Both write only through the area services (members, staff
profiles, ranks, schedule, attendance), as the system actor, in their short transactions. They
send no email and write no upload, so they are safe in demo mode and as the development seed
(`gym-app seed <gym-uuid>`).

## What a sandbox gets

* **Members:** 14 households (families with children and single adults), 22 fictional members
  with mixed statuses (active, trial, prospect, frozen, cancelled), emergency contacts, member
  tags, and one medical note. Contact details use the reserved `example.invalid` domain and
  555-01xx numbers. Join dates are backdated by giving the services a seed-local clock.
* **Kiosk PIN:** every seeded household gets PIN `2468` (`demoPin`), so visitors can try name
  and PIN check-in. Setting a PIN needs the gym key; the default steps read
  `APP_ENCRYPTION_KEY`, and without it households get no PIN.
* **Staff profiles:** four instructors. The head instructor and one coach link to the gym's
  first owner (or admin) and coach accounts, which demo mode creates; staff management requires
  an owner or admin, so a gym without one gets no profiles and unassigned classes.
* **Schedule:** a weekly timetable of adult classes, kids classes, and a Saturday open mat.
  Materializing from four weeks ago creates four weeks of history and four weeks ahead through
  the job's own code; the nightly job extends the rest. One upcoming class is cancelled.
* **Promotion criteria:** ranks that still have none get classes-since-promotion and
  time-at-rank criteria (the gym can edit them). Ranks that already have criteria are untouched.
* **History:** promotion history in the pack's adult and kids programs, and four weeks of class
  and open-mat attendance (kiosk and coach sources, recorded at check-in time). With these
  criteria five members are promotion-ready and two haven't been seen for 14+ days.

## Retries

Each step looks up what it created before (households by name and email, members by name within
them, profiles by name, templates by name, weekday, and time, promotions by rank) and adds only
what is missing; materialization is idempotent. Members who already have attendance get none
added, because the history weeks move with the clock. Households, promotions, and attendance
are seeded four at a time, each in its own short transactions.
