<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Importing from another system

How to bring members, memberships, ranks and attendance over from your old gym
software using CSV files. You can import during the [setup wizard](self-hosting.md#setup-wizard)
(its last step) or any time later from the admin's **Import and export** page
(`/admin/imports`). Importing never charges anyone, never sends an email and never
changes your plans.

Plan for a few days of running both systems side by side: import, check the result,
collect cards ([card-recollection.md](card-recollection.md)), and only then turn
billing on ([going-live.md](going-live.md)).

## 1. Get CSV files out of your old system

Export one file per kind of data. Each must be:

* UTF-8, up to 20 MB, with one header row;
* made of uniquely named columns, with the same number of cells in every row (the
  upload is refused otherwise).

The importer reads three kinds of file, and you import them in this order.

| Import type | What it brings in | Needs first |
| :--- | :--- | :--- |
| **People** | Members and their households | Nothing |
| **Memberships** | Active memberships and their next due dates | The people, and your plans created in **Billing catalog** |
| **Ranks and attendance** | Promotion history and attendance records | The people, and the programs and ranks (from the content packs you chose in setup, or created under **Ranks & promotions**) |

### People columns

Each file's columns are matched to these fields in step 3. Names that look like a field
(`First Name`, `Email`, `DOB`, `Customer ID`, `Member ID`) are matched for you; you
can change any match.

| Field | Notes |
| :--- | :--- |
| First name, Last name | Required. |
| Email, Phone | Optional. Siblings may share an email. |
| Date of birth | `YYYY-MM-DD` is safest. Day-first and month-first dates are understood when the file is consistent; otherwise the ambiguous cells are errors to fix. |
| Status | Common labels are understood: prospect, trial, active, frozen (also "on hold", "paused", "suspended"), cancelled (also "inactive", "former", "expired") and visitor. Anything else is an error, never guessed. |
| Household external ID, Household name, Billing day | Link relatives: give each family member the same household ID, or point relatives at the primary member's ID. Names or a shared email alone never join a family. |
| External ID | Your old system's member ID, used inside the file for family links and duplicates. It isn't kept as a member ID. |
| Email opt-out, Tags | Optional. Opt-out accepts yes/no, true/false, 1/0. |
| Stripe customer ID, Stripe payment method ID | Optional, and only useful when your old system used **your own Stripe account** ([card-recollection.md](card-recollection.md#cards-already-in-your-stripe-account)). |

PINs and medical notes are never imported: remove those columns, and any unrelated
ones, from the mapping.

### Memberships columns

Each row needs an email (or both names), the **plan's name** (or its ID) exactly as
it is in **Billing catalog**, and **Next due date** as `YYYY-MM-DD`. Optional: amount in
cents, billing interval (`monthly` or `annual`), currency (it must equal the plan's),
commitment end date, billing day. Missing prices and intervals use the plan's. The
catalog is never changed by a price in the file. An amount must be one Stripe can charge:
a multiple of 100 in ISK and UGX (whole units), and of 10 in BHD, JOD, KWD, OMR and TND.

Check the next due dates. Each membership keeps the date as given, even a past one.
When billing is later turned on, a membership due in the past is invoiced for each
missed period, and the go-live page asks you to confirm every one first. Export
after your old system's last billing run and before its next, so a date isn't billed
twice.

### Ranks and attendance columns

Each row is either a **promotion** (program, rank, promotion date, optional sub-rank)
or an **attendance** record (attendance date, optional program and class tags), never
both. Rows are matched to existing members by email or by first and last name
(plus date of birth if you map it); a row that matches nobody, or several people,
is an error. A date without a time is the start of that day in your gym's timezone;
future dates are refused. Map a stable visit ID to External ID so a re-import
doesn't duplicate attendance.

## 2. Upload, match, check, commit

For each file, in order:

1. Open **Import and export**, choose the **Import type** and the **CSV file**.
2. **Match columns.** Check every row of the mapping; choose *Ignore column* for
   anything you don't want. Each field can be matched to one column only.
3. Choose how to treat **Duplicates**: *Report an error* (the default; safest for a
   first import), *Skip* (keep what is there), or *Update one match* (apply the file to
   the one existing member that matches; several matches can't be updated).
   Members match by full name plus email or date of birth.
4. **Preview and dry run.** The preview lists each row as create, update, skip or
   error. A dry run checks the whole file and writes no member data. Fix the errors
   in your CSV and upload it again until the dry run is clean. Changing the type,
   duplicates setting or column matches needs a new dry run.
5. **Commit.** The import runs in the background in batches; a progress count shows
   how far it is. When it reports *Complete*, check **Members**.

If a run fails part-way, rows committed before the failure stay saved. Read the
error report, correct the CSV, choose *Skip* (keep existing records) or *Update one
match* (apply corrections), and run a fresh dry run before committing again.
Re-importing an unchanged file creates nothing new.

During setup, the same steps appear in the wizard's last step; **Finish with this
import** completes setup once the import is committed. Billing and member emails
stay off after setup.

## 3. Check the result

* **Members** shows the people and their households, with the statuses you mapped.
* A member's profile shows their membership, rank history and attendance.
* **Settings → Go live** lists members, memberships and past-due dates under its
  checklist ([going-live.md](going-live.md)).
* Uploaded CSV files are kept for 24 hours and their run records for 30 days, then
  removed automatically.

## Exporting your data

The same page's **Export gym data** makes a ZIP with one CSV per dataset. The download
link expires after an hour; create another export if it has. Credentials, secret
hashes, audit payloads and email bodies are not included. Technical details of the
import and export pipeline are in `apps/server/src/areas/imports/pipeline.md` and
the mapper notes next to it.
