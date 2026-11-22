<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Membership screens

The membership tab requires `billing.read`. Owners and admins can assign plans,
edit a membership, and change its plan. Coach and front desk sessions have no
discount details, selectors or controls; discount management requires `plans.manage`.

Membership changes refresh the gym's member profile and list caches as well as
the membership tab, so a derived status and its new revision appear immediately.
The member's status follows any active membership, then trial, then frozen, or
cancelled when all are cancelled. Pending-only live memberships and members without
memberships keep the staff-set status. See the
[membership status rule](../../../../../server/src/areas/billing/memberships.README.md#member-status).

Before freezing, the form names the first skipped billing date and explains that
resuming immediately or freezing a trial still skips it; a later timed resume can
skip more cycles. Freeze history is available with `billing.read`, loads on demand,
and pages through the recorded freezes, newest first. Each event shows when it
happened in the gym's timezone, the skipped billing date and the next due date
recorded at the freeze. These dates survive later resumes and edits. Read errors
offer a retry and an empty history is explicit.

Assignment optionally selects a named active discount for the plan or accepts a
code. Codes ignore letter case. Changing the plan clears the selection. Saving
checks availability on the server and displays ended, used-up and wrong-plan
refusals without discarding the form.

Membership refusals that carry a reason (see the
[membership refusals](../../../../../server/src/areas/billing/memberships.README.md#membership-refusals))
get their own message. After a changed household billing date, a household
that must bill on its start date, a changed status or a cancelled membership,
the tab reloads its membership data. After either billing-date refusal, the
assignment form shows the reloaded household date in place of a typed one and
keeps the rest of the draft. A changed status or cancellation closes the
refused Freeze, Resume or Change price form, or the refused Cancel membership or
Cancel scheduled change confirmation, and its message stays shown.

The assignment form keeps the plan it shows, including the first plan it showed
by default, when a refresh reorders the plan list, so its discount stays chosen.
If an assignment is refused because the plan is inactive, the picker reloads.
If the shown plan is gone, the form selects the first active plan, or shows the
empty state when none remain. The discount for the removed plan is cleared.
When a background refresh removed the plan, a notice beside the picker names the
replacement and asks staff to review it. If the reload after an inactive-plan
refusal removes the plan, the refusal message explains the replacement. A
background refresh that removes the plan before or after that reload still
shows the notice. Choosing a plan clears the notice. A successful assignment
clears the notice shown at submission. Any replacement notice that appeared
during the save stays visible, even if the picker returned to the submitted plan.

Owners and admins see the membership's applied discount snapshot and billing
cycles left (or an ongoing duration). They can add or replace a price discount,
or confirm its removal. The named list offers only discounts that cover both
the current plan and any scheduled plan. Signup-fee-only waivers are available at assignment only.
Changes take effect on the next invoice, without proration or changes to issued
invoices. Replacing takes a new use; removing does not return the old use. Each
change sends the membership revision read when its form opened. A revision
conflict requires closing and reloading before retrying.

The Change plan dialog shows the server preview's discount outcome: kept on the
new plan, ended because it is ineligible, or no discount to carry over. Scheduled
switches keep the current discount visible until the switch takes effect.

Discount forms stack at phone width and use native selectors and 44 px controls.
Browser coverage checks the flows at 360 px and desktop widths.
