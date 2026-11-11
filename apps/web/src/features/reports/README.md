<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Reports

`/admin/reports` registers through `reports.read`. Owners and admins see
attendance, member activity and revenue; coaches see attendance. Front desk and
member-only sessions cannot open the page. The server enforces access on each
report route independently. The page requests only the selected report, with
gym, user, range and granularity in its query key and cancellation on navigation.

The default range is twelve inclusive months through the gym's current month.
Apply a range of at most 24 months. Attendance supports month or week and a
program filter. Zero-activity periods stay in filtered tables; unique members
must not be added across program rows. Boundary periods retain the
API's partial marker for completed periods. Current periods show In progress and
future weeks within the requested current month show Upcoming, using the gym's
timezone even when the API supplies a full calendar-period boundary.

Small SVG bar and line charts have descriptions, legends and their data tables
immediately below. Tables scroll within labelled, keyboard-focusable containers
on phones. Revenue has one section per currency, with separate tax rows and a
total including tax; it never adds currencies together. Amounts use
`@plaingym/shared/money` and appear as plain decimals alongside currency codes.

`data.ts` builds each table once. `DataTable` renders those columns and rows and
passes the same object to `csv.ts` for browser downloads. CSV includes a UTF-8
BOM, quoted fields, CRLF records, ISO dates and formula-prefix neutralization
(including negative numeric cells). Filenames contain report, month range and,
where applicable, currency or attendance granularity. No CSV or chart dependency
or additional API route is used.

`api.test.ts`, `csv.test.ts` and `page.test.tsx` cover transport, roles, range
validation, report states, filtering, keyboard navigation and rendered-table/CSV
parity. After installing the `e2e/` dependencies and pinned Playwright Chromium,
run `node apps/web/src/features/reports/mobile-check.mjs` for standalone browser
checks at 360 and 1280 px. It uses `E2E_LOOPBACK`, mocks API answers, checks axe,
page overflow, 44 px controls and a real CSV download, and saves screenshots in
`coverage/reports/`. It closes its browser and preview server when finished.
