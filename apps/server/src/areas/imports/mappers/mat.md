<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Mat import mapper

`matMapper` imports promotion history and attendance history for existing members.
Each CSV row is one record:

* **Promotion:** `rank` and `promotedAt` (plus `program`, required, and an optional
  `subRank`). `subRank` is a count of sub-ranks reached (`0` = none) or the name or
  ID of one of the rank's sub-ranks.
* **Attendance:** `occurredAt`, with an optional `program`. A visit is open mat when
  `program` or one of its `classTags` reads "open mat" (in any case or spacing);
  otherwise it is a class. Other class tags are ignored: session-less attendance has
  no tags. An unknown "Open Mat" program only sets the kind.

A row with both a rank and an attendance date, or with neither, is an error.

## Matching

Members are matched by every identity field the row supplies: `email`, `firstName`,
`lastName` and `dateOfBirth`, case-insensitively. A row needs an email or both names.
Rows matching no member, or several, are errors, and anonymized members never match.
Programs match by name; ranks match by name within the program's rank system, so a
promotion always records the rank system its program and rank share. Every lookup
is filtered by the import's gym (and row-level security), so another gym's members,
programs or ranks are never matched.

Dates use ISO 8601: `2024-03-01`, or `2024-03-01T18:30` with optional seconds and an
optional `Z` or `±hh:mm` offset. A value without an offset is a wall time in the gym's
timezone, and a date alone is the start of that local day. A time skipped when clocks
go forward moves forward by the gap; a time repeated when they go back is the earlier
instant. A run reads every row in the timezone it started with. Future dates are rejected.

## Duplicates and re-imports

* Attendance is stored with `source: 'import'`, no session, and a SHA-256 source key
  prefixed with `mat:`, unique within the gym (`attendances_source_key`). Map a
  stable source identifier to `externalId` when available. Distinct visit IDs
  keep repeated visits at the same time distinct; IDs are case-sensitive. Use a
  source prefix if combining exports whose IDs could overlap. The key always
  includes the member, instant, program and kind, so auto-matched member IDs work
  across a member's entire history too. Identical visits without
  IDs are duplicates. Reordering rows or uploading the history again keeps the keys.
* A promotion matches an existing one with the same member, program, rank, sub-rank
  and time.
* Within the file, a later row with the same identity as an earlier row is reported
  as a duplicate of that row. The index is built from the run's full immutable source
  rows, cached per source array and mapping only.
* Imported history is immutable: an exact match has nothing to update, so the
  `update` policy reports it as skipped; `skip` skips it and `error` reports it.

A promotion must rank above every earlier promotion of the member in its program and
below every later one, counting existing history and all promotion rows for that
member in the source file. Preview, dry run, and commit validate across chunk
boundaries, including rows that identify the same member by different combinations
of email and name. Contradicting rows are errors in each mode. A duplicate row does
not make its first occurrence a chronology error. Only parsed source data is
cached; member and rank references are resolved again for each analysis. Writes
still commit in chunks of at most 100 rows and recheck chronology under the lock.

## Commit

`commit` refuses chunks larger than 100 rows. It locks members (as `areas/ranks`
does), checks their analyzed revisions, and locks and revision-checks referenced
programs and ranks before writing. History rows are inserts only; existing history
is never edited. Attendance uses `ON CONFLICT DO NOTHING` on the source key and
counts only inserted visits. Promotions recheck exact matches and chronology under
the member lock so concurrent imports never insert duplicates or contradict a
promotion committed since analysis, and record no promoter or notes. Each inserted row gets an `attendance.recorded` or
`promotion.created` audit event with IDs, times, kind and the import ID only; no
names or emails reach the append-only audit log. The mapper never calls storage, HTTP
or a nested scope.

Eligibility counts classes since a member's latest promotion in the program (or since
the member was created, before any promotion). Import each member's current rank and
its date, or their starting rank, so imported attendance counts toward the next one.
