<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Content packs

`loadContentPacks(directory)` reads and validates the JSON definitions in a pack
directory (default: `./packs`). It returns definitions, including rank colors;
it does not install them. Duplicate catalog IDs fail validation.

`createContentPackService({ scope, clock })` provides `list(gymId, pagination)`
and `apply(mutationContext, definition)`. The registered endpoints list **installed**
packs and apply a submitted definition, as specified by `ranksContracts`.

Each application runs in one gym transaction. A unique installation row and row
lock serialize simultaneous applications of the same pack. Entity UUIDs retain
the installation UUIDv7 timestamp and derive their remaining bits from its UUID,
the entity kind, and the pack's stable entity IDs. Keep those IDs stable when
renaming definitions. Different gyms get different installation and entity IDs.

Reapplication updates the pack's names, rank positions, sub-ranks and program
links, using revision guards. Unchanged records retain their revisions. Staff
promotion criteria and program activation flags are preserved. Application is
additive: omitted entities are retained, since gym records may reference them.
Conflicting names, occupied rank positions, or referenced program links cause a
409 and roll back the whole application. Existing class tags with matching names
are reused as shared vocabulary; applying a pack does not rename those shared
tags. Pack-owned tags retain their stable identity on rename.

Every successful application writes an audit event with the submitted, validated
definition and injected time in the same transaction. The frozen rank table and
rank response currently have no color field. `TODO(CCR)` in the service marks
that gap; colors remain in the audit definition and disk catalog without being
placed in unrelated rank fields.
