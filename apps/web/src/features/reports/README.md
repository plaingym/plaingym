<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Reports

`/admin/reports` registers through `reports.read`. Owners and admins see
attendance, member activity and revenue; coaches see attendance. Staff assigned
both coach and front desk roles also see member activity (`reports.read` plus
`billing.read`); revenue requires `reports.revenue`. Front desk alone and
member-only sessions cannot open the page. The server enforces access on each
report route independently. The page requests only the selected report, with
gym, user, range and granularity in its query key and cancellation on navigation.
Queries stay fresh for one minute, so switching tabs reuses recent answers. The
attendance program and granularity survive tab switches; applying a range or
changing granularity resets the program filter to All programs.
A refreshed answer that no longer contains the selected program also resets it
to All programs, using the same selection for the control, table, chart and CSV.

The default range is twelve inclusive months through the gym's current month.
Month ranges, table dates and chart labels use readable calendar labels without
shifting dates into the browser's timezone. Each period includes its start date
and stops before its Before date. A selection with zero counts keeps the chart
and table and explains the zeros; an empty answer says there are no results.
Apply a range of at most 24 months. Attendance supports month or week and a
program filter. Zero-activity periods stay in filtered tables; unique members
must not be added across program rows. Boundary periods retain the
API's partial marker, including alongside In progress or Upcoming. Current periods
show In progress from the server clock's `inProgress` snapshot; later buckets
in that same answer show Upcoming. Labels use only the snapshot, so browser
clock differences and time spent viewing an answer cannot change its statuses.

Small SVG bar and line charts have descriptions, legends and their data tables
immediately below. Tables scroll within labelled, keyboard-focusable containers
on phones. Revenue has one section per currency, with separate tax rows and a
total including tax; it never adds currencies together. Amounts use
`@plaingym/shared/money` and appear as plain decimals alongside currency codes.

`views.tsx` memoizes tables, program choices and chart series by report data and
program selection. `DataTable` renders those columns and rows and
passes the same object to `csv.ts` for browser downloads. CSV includes a UTF-8
BOM, quoted fields, CRLF records, readable calendar dates and formula-prefix neutralization
except for plain numbers matching `^-?\d+(\.\d+)?$`, which stay numeric, including
negative discounts, refunds and nets. Every other cell starting with `-`, `=`,
`+`, `@`, tab or carriage return gets a leading apostrophe. Filenames contain report, month range and,
where applicable, currency or attendance granularity. No CSV or chart dependency
or additional API route is used.

`api.test.ts`, `csv.test.ts` and `page.test.tsx` cover transport, roles, range
validation, report states, filtering, keyboard navigation and rendered-table/CSV
parity. After installing the `e2e/` dependencies and pinned Playwright Chromium,
run `node apps/web/src/features/reports/mobile-check.mjs` for standalone browser
checks at 360 and 1280 px. It uses `E2E_LOOPBACK`, mocks API answers, checks axe,
page overflow, 44 px controls and a real CSV download, and saves screenshots in
`coverage/reports/`. It closes its browser and preview server when finished.
