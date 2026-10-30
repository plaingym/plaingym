<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Kiosk check-in

`configureKiosk({ pinSecret, uploadsFor, clock })` supplies the same random gym
key resolver as member management, plus gym-scoped photo storage. The production
runtime configures it before serving requests. Unconfigured PIN lookup fails
closed. `createKioskCheckinRoutes(service)` supports isolated route tests.

The device middleware authenticates each request and limits PIN lookup and
submission to 10 failed PIN attempts per minute per device and client address.
Requests reserve a slot while verification runs; a uniquely verified household
PIN releases its own slot, including when standing returns the neutral front-desk
result. Prior failures remain counted. Every
submission verifies the name and household PIN again, reloads the household's
members, and evaluates standing. A guess is checked against at most three
households where a member's first or last name, or a word of the household
name, starts with the search; a wider match
goes to the front desk, and a first and last name narrows a common surname.
Multiple matching households, invalid PINs,
members outside the household, and failed checks receive the same neutral
front-desk result. Lookup displays only first names, last initials, and optional
five-minute photo links. Credentials, roster data, and standing reasons are
never persisted in browser storage; only the revocable device token is saved.

The browser caches the current household roster in component memory so members
can change the family selection without another lookup. Returning to the search
screen, finishing check-in, or inactivity clears that roster and the PIN. Reads
are not an authorization grant: the server rechecks every submission. Late
responses cannot repopulate a screen that was reset.

`createStandingChecks` accepts providers implementing `KioskStandingCheck`.
Inactive and missing-waiver checks are enabled, along with the billing extension
point. Each waiver family's latest version is required unless retired;
membership agreements are excluded. Provider failures fail closed. Only the
staff standing route exposes reason codes; device responses contain no reason
text or billing fields.

Sessions open for check-in one hour before starting and close at their end.
A single booking is selected automatically; otherwise the member chooses among
current sessions or open mat. Attendance goes through `createAttendanceService`
with `source: 'kiosk'` and the device audit actor. The attendance service
deduplicates session check-ins under concurrency. Session-less open-mat visits
retain each explicit tap. The browser makes one attempt per submission, never
queues offline visits, and never retries an uncertain write automatically.

The kiosk works with keyboard input or the touch keypad and offers the browser's
fullscreen control. Feedback uses visible result labels and optional short
audio tones. Completed results clear after eight seconds; unfinished screens
clear after sixty seconds without interaction. The source-code footer remains
part of the shared application shell.
