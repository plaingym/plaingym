<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Membership screens

The membership tab requires `billing.read`. Owners and admins can assign plans,
edit a membership, and change its plan. Coach and front desk sessions have no
discount details, selectors or controls; discount management requires `plans.manage`.

Assignment optionally selects a named active discount for the plan or accepts a
code. Codes ignore letter case. Changing the plan clears the selection. Saving
checks availability on the server and displays ended, used-up and wrong-plan
refusals without discarding the form.

Owners and admins see the membership's applied discount snapshot and billing
cycles left (or an ongoing duration). They can add or replace a price discount,
or confirm its removal. Signup-fee-only waivers are available at assignment only.
Changes take effect on the next invoice, without proration or changes to issued
invoices. Replacing takes a new use; removing does not return the old use. Each
change sends the membership revision read when its form opened. A revision
conflict requires closing and reloading before retrying.

The Change plan dialog shows the server preview's discount outcome: kept on the
new plan, ended because it is ineligible, or no discount to carry over. Scheduled
switches keep the current discount visible until the switch takes effect.

Discount forms stack at phone width and use native selectors and 44 px controls.
Browser coverage checks the flows at 360 px and desktop widths.
