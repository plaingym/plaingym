<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# People CSV mapper

`peopleMapper` plugs into the existing import pipeline without additional runtime
wiring. It analyzes with the supplied read-only handle and writes only inside
the pipeline's transaction, in chunks of at most 100 rows. Preview and dry runs
do not change domain data. Importing stores processor IDs; it makes no payment,
email, storage or HTTP calls.

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

Updates lock the current member or household and check its revision. Audit
payloads contain only the import run ID, with no names, contact details or
processor IDs. Existing household names/contact details are preserved; updates
can change billing day or fill a missing customer ID. A customer or payment
method already owned by another household is rejected. Existing saved methods,
including revoked methods, are preserved; new methods only become default if
the household has no default. Stripe IDs remain case-sensitive.
