<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# People CSV mapper

The whole-file index retains shared families and compact per-row flags. A
customer-keyed family of one is rebuilt from its source row during analysis,
including when the member has an independent external ID.

`createPeopleMapper` lets the import pipeline resolve new Stripe payment method
IDs before opening each chunk's database transaction. The mapper analyzes with
the supplied read-only handle and writes in chunks of at most 100 rows. Preview
and dry runs do not change domain data. Importing stores processor references for
later billing.

Map the source columns to first and last name, optional contact details, birth
date, status, email opt-out, tags, household references/name/billing day and Stripe
IDs. Unknown statuses and invalid cells become errors instead of guessed values.
Birth dates accept ISO dates and unambiguous numeric dates. A consistently
day-first or month-first date elsewhere in the file resolves ambiguous cells;
otherwise change those cells to YYYY-MM-DD. Unmapped optional cells preserve
existing member values on update. PINs and medical notes are never imported.
Remove medical notes and unrelated fields from the suggested mapping.

A household reference links relatives to a primary member's source ID, or
groups rows by a common household ID. A shared Stripe customer also groups rows
without explicit family links. Names or shared email alone never join families.
An existing matched member or the saved customer locates an existing household.
If the family matches several households, correct the links before importing;
the mapper never moves an existing member to another household. When creating a
household, its contact details and other shared values come from the first
nonempty cell in that family. Conflicting shared values are reported.

Source IDs identify duplicates and family links within the file; they are not
persisted as member IDs. Existing members match by normalized full name plus
email or birth date. A row without either detail matches by full name; it also
remains a duplicate candidate when another row supplies those details. Siblings
can share an email because names are part of the identity. Review homonyms and
use birth dates to distinguish them. Anonymized members are never matched.
Within-file repeated identities are errors on later rows, even under skip or
update policy. Existing duplicates use the pipeline's error/skip/update policy;
multiple existing matches cannot be updated. Identical reimports create no new
members. Indexes cover the immutable full file, including families and repeated
identities spanning chunks; database matches always use the supplied gym scope.
Existing-member candidates use the gym-first partial index
on the generated `lower(last_name)` column (migration `0019`), excluding anonymized
members. Query names are folded by PostgreSQL too, preserving its collation's
case matching without treating wildcard characters as patterns. Identity and household matching rules
are unchanged; edits automatically update the generated value.
The whole-file index keeps no mapped row: for each row only its family and the
issues the file decides (a repeated identity, a family mismatch, a customer or
payment method another family uses), and for each family of several rows,
its shared values, last names and lookup keys; a family of one is read from
the row itself, preserving whether its household key or customer key won. Each
chunk maps its own rows again, with the date order the file decided.

Updates lock the current member or household and check its revision. Created
members and households store their phone normalized with the gym's country,
without SMS consent. A changed member phone is normalized the same way. If its
normalized number changes, the update clears the member's notices and
announcements consent in the same transaction. Unchanged numbers, including
formatting-only edits, keep consent when it belongs to that number. A
formatting edit also clears stale consent whose stored normalized number
differs, so normalizing cannot revive it; blank or unmapped phones preserve the
existing phone and consent. Consent changes are audited with the `staff` source
and contain the consent kind, time and source, never the phone. Other audit
payloads contain only the import run ID, with no names, contact details or
processor IDs. Existing household names and contact details, including the
billing phone and its notices consent, are preserved; updates can change billing
day or fill a missing customer ID. A customer or payment
method already owned by another household is rejected. Existing saved methods,
including revoked methods, are preserved; new methods only become default if
the household has no default. Stripe IDs remain case-sensitive.

For a verified bank account, the type must match the gym's currency (US bank
account for USD or Canadian bank account for CAD) and the Stripe customer must
match the household's. The Stripe import read accepts an untagged customer in
the gym's account. It refuses bank accounts tagged for another gym and enforces
the customer's household tag when present. A Canadian bank account without an
active reusable mandate from off-session setup produces a row error. A denied
mandate read and other provider lookup failures produce row-specific errors
while valid rows proceed. The mapper writes the bank type, bank name, masked
digits and any mandate ID supplied by Stripe. Unresolved references keep the
existing ID-only import behavior. If
the gym settings revision changes before a prepared bank account is written,
the job rolls back the chunk and prepares it again on retry.
