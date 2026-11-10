<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Announcements

Owners and admins open `/admin/announcements` through the staff navigation
(`announcements.send`). Compose a plain text subject and message, optionally
filter by member status and programs, preview the eligible recipient count,
send a test to the signed-in sender, then confirm the member send. Preview
includes the gym name, message and unsubscribe footer. The test email adds a
test notice and leaves the unsubscribe footer inactive.

The dialog blocks simultaneous operations and dismissal while a request is
running. After a send attempt, retries keep the same immutable draft and send
generation, including when the response was lost. Edit before confirming to
refresh the preview. The server rechecks eligibility at delivery time.

Member-email and SMTP refusals explain the required Settings section. SMTP
credentials are owner-managed. History refreshes every five seconds while a
shown announcement is still delivering, shows
newest announcements first and includes the gym-local date, sender and sent,
failed and skipped counts. Senders without a staff profile display their
account ID. History uses stacked cards on phones.

`page.test.tsx` and `api.test.ts` cover interactions, role gating and transport.
`node apps/web/src/features/announcements/mobile-check.mjs` builds a standalone
browser fixture and checks 360 px and desktop layouts, touch targets and axe.
It uses mocked API responses and closes its preview server and browser.
