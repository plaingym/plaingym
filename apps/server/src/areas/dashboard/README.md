<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Dashboard

`configureDashboard({ members, ranks, attendance })` injects the members and ranks
services and the frozen `AttendanceQueries` implementation. The optional `notSeen`
read defaults to `createNotSeenRead(forGym)`; tests can inject a scoped read. The static route is
included in the area barrel and OpenAPI generation; it returns 503 until configured.
The request supplies the gym, staff roles, clock, and enabled modules. Responses
are not cached by HTTP, and the web query cache includes the gym and roles.

`createWidgetRegistry(schema)` accepts frozen `DashboardWidgetProvider` entries,
rejects duplicate IDs, filters permissions and disabled modules before reading,
and validates both the provider schema and the surface contract. Providers may
return `null` to omit an empty alert; zero-valued summary metrics remain visible.
A provider error fails the request; no internal error text is rendered by the page.
The billing endpoint and panel use the same registry (see `billing.README.md`).

Mat widgets use area services and a grouped last-seen read. Active membership means member status
`active`. Not-seen includes active members whose last visit (class or open mat) was
at least fourteen elapsed days ago. Never-attended members receive fourteen days
from creation; future attendance is ignored. Both detail widgets expose at most
100 members while their counts cover the full roster.

Promotion-ready delegates criteria to ranks eligibility, considering the first
available rank/sub-rank in rank-position order for each active program. An unmet
next step cannot be skipped in favor of an easier higher rank. Members ready in
several programs appear once, using the first program in service order. Enabled
module criteria are forwarded. All service reads use separate short transactions;
the dashboard never wraps service calls in a transaction. The last-seen query
joins active members to attendance within `forGym`, groups visits by member,
and preserves the member service's name/ID ordering. It uses one query regardless
of roster size; member status is filtered in SQL.

Unfiltered ranks eligibility paginates candidate members before evaluating their
criteria. The dashboard stops reading higher ranks once each active member's next
step has been considered. A 500-member roster with five ranks and one class-count
criterion per rank therefore makes 500 criterion attendance reads when every
member's next step is the first rank, rather than repeating all members on every
page and rank. Promotion details still use one history read per displayed ready
member (at most 100); not-seen uses the grouped query. Filtering
eligibility by `readyOnly` evaluates all candidates before paginating the matches.
