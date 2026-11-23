<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Announcements

Owners and admins open `/admin/announcements` through the staff navigation
(`announcements.send`). Compose a plain text subject and message, optionally
filter by member status and programs, preview the eligible recipient count,
send a test to the signed-in sender, then confirm the member send. Preview
includes the gym name, message and unsubscribe footer. The test email adds a
test notice and leaves the unsubscribe footer inactive. A validated draft can
also be tested from Compose while member email is switched off; member delivery
still requires a successful preview and confirmation.

The optional text composer shows the gym prefix and mandatory STOP line, the
complete 480-character limit and the shared GSM-7/UCS-2 segment estimate. Preview
shows distinct consenting phone recipients and server segment counts.
When the text recipients exceed the daily cap's remaining texts for the day they'd go
out, the preview warns how many won't get the text (they get the email only). The
warning doesn't block sending. Confirmation
names both email and text totals; zero email recipients do not block a text send.
The typed test phone receives only the text test, counted against the daily cap.
Quiet-hour guidance explains the 08:00-21:00 gym-local window and deferred 08:00
delivery. History shows independent SMS counts and its scheduled time, and polls
every 5 seconds while delivery runs. While texts only wait for quiet hours, it polls
when they're due and at least every 5 minutes.

The dialog blocks simultaneous operations and dismissal while a request is
running. After a send attempt, retries keep the same immutable draft and send
generation, including when the response was lost and the dialog was closed and
reopened in this workspace. A definite refusal restores Edit with refusal guidance
only if no earlier request in that attempt had an uncertain outcome. Once a
response is lost or a replay conflicts, later refusals keep the same attempt and
retry guidance until the server confirms acceptance or staff choose Start over.
Start over requires a separate confirmation to check history first and warns
that sending a new announcement could mail members twice. Confirming clears the
saved retry and returns to compose with the same message and filters; the next
preview uses a new send generation. Cancelling keeps the original retry.
The retained attempt lasts until the workspace is left or reloaded; the dialog
warns to check history before leaving. Edit before confirming to
refresh the preview. The server rechecks eligibility at delivery time.

Member-email, SMTP and missing canonical HTTPS origin refusals explain the
required configuration alongside retry guidance for a retained attempt. Settings
links open in a separate tab to preserve the draft; only owners see SMTP and
address settings links. SMTP credentials are
owner-managed. History refreshes every five seconds while a
shown announcement is still delivering, shows
newest announcements first and includes the gym-local date, sender and sent,
failed and skipped counts. Senders without a staff profile display their
account ID. History uses stacked cards on phones.

`page.test.tsx` and `api.test.ts` cover interactions, role gating and transport.
`node apps/web/src/features/announcements/mobile-check.mjs` builds a standalone
browser fixture and checks 360 px and desktop layouts, touch targets and axe.
It uses mocked API responses and closes its preview server and browser.
`e2e/specs/announcements.spec.ts` checks the production dialog's compose tests,
refusals and recovery at 360 px and 1280 px, including screenshots and axe.
