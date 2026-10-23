<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Dashboard

`configureDashboard({ members, ranks, attendance })` injects the members and ranks
services and the frozen `AttendanceQueries` implementation. The static route is
included in the area barrel and OpenAPI generation; it returns 503 until configured.
The request supplies the gym, staff roles, clock, and enabled modules. Responses
are not cached by HTTP, and the web query cache includes the gym and roles.

`createWidgetRegistry(schema)` accepts frozen `DashboardWidgetProvider` entries,
rejects duplicate IDs, filters permissions and disabled modules before reading,
and validates both the provider schema and the surface contract. A provider error
fails the request; no internal error text is rendered by the page. Billing has an
empty registry factory, route stub, view list, and panel stub. Billing providers,
their endpoint, and their panel can be implemented without changing the framework.

Mat widgets read only through area services. Active membership means member status
`active`. Not-seen includes active members whose last visit (class or open mat) was
at least fourteen elapsed days ago. Never-attended members receive fourteen days
from creation; future attendance is ignored. Both detail widgets expose at most
100 members while their counts cover the full roster.

Promotion-ready delegates criteria to ranks eligibility, considering the first
available rank/sub-rank in rank-position order for each active program. An unmet
next step cannot be skipped in favor of an easier higher rank. Members ready in
several programs appear once, using the first program in service order. Enabled
module criteria are forwarded. All service reads use separate short transactions;
the dashboard never imports another area's tables or wraps service calls in a
transaction.

Unfiltered ranks eligibility paginates candidate members before evaluating their
criteria. The dashboard stops reading higher ranks once each active member's next
step has been considered. A 500-member roster with five ranks and one class-count
criterion per rank therefore makes 500 criterion attendance reads when every
member's next step is the first rank, rather than repeating all members on every
page and rank. Last-seen still uses one history read per active member. Filtering
eligibility by `readyOnly` evaluates all candidates before paginating the matches.
