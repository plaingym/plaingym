<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Dashboard

`createDashboardService({ members, ranks, notSeen })` requires an
explicit scoped `notSeen` read from `createNotSeenRead(scope)`. This read also
supplies `lastSeen(context, memberIds)` for promotion details. Providers have no
global database fallback. The runtime passes `createNotSeenRead()`; tests inject
their isolated scope. The static route is
included in the area barrel and OpenAPI generation; it returns 503 until configured.
The request supplies the gym, staff roles, clock, and enabled modules. Responses
are not cached by HTTP, and the web query cache includes the gym and roles.

`createWidgetRegistry(schema)` accepts frozen `DashboardWidgetProvider` entries,
rejects duplicate IDs, filters permissions and disabled modules before reading,
and validates both the provider schema and the surface contract. Providers may
return `null` to omit an empty alert; zero-valued summary metrics remain visible.
A provider error fails the request; no internal error text is rendered by the page.
The billing endpoint and panel use the same registry (see `billing.README.md`).
`leads.ts` provides the `leads.follow-ups-due` extension widget for staff with
`leads.manage` (see `areas/leads/README.md`).

Mat widgets use area services and indexed last-visit reads. Active membership means member status
`active`. Not-seen includes active members whose last visit (class or open mat) was
at least fourteen elapsed days ago. Never-attended members receive fourteen days
from creation; future attendance is ignored. Both detail widgets expose at most
100 members while their counts cover the full roster.

Promotion-ready delegates to ranks `dashboardEligibility`, considering the first
available rank/sub-rank in rank-position order for each active program. An unmet
next step cannot be skipped in favor of an easier higher rank. Members ready in
several programs appear once, using the first program in service order. Enabled
module criteria are forwarded. All service reads use separate short transactions;
the dashboard never wraps service calls in a transaction. The last-seen queries
use a lateral lookup on `attendances_member_time_idx` within `forGym`. Not-seen
filters member status and the fourteen-day cutoff in SQL, counts all matches
with a window count, and returns at most 100 rows in name/ID order. Promotion
details use the same visit rule in one read for the displayed member IDs.

The batch eligibility path reads active programs, their ranks, the active roster,
and each member's latest promotion in four sequential queries. One grouped query
counts classes since each candidate's promotion (or creation), including linked
session programs and the gym's open-mat setting. The criteria registry still
validates configuration, module availability and provider results. Time, age and
extension criteria use their existing providers outside the snapshot transaction.
The staff eligibility endpoint and portal progress retain their existing paths.

With one built-in class criterion, an owner load of both dashboard endpoints uses
12 SELECTs at either 300 or 1,000 members and holds at most two of the app pool's
eight connections (one per endpoint). These bounds cover the built-in mat and
billing widgets; independently registered alerts and extension criteria add their
own reads. No dashboard read holds a transaction while another service runs.
