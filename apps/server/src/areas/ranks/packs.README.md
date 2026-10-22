<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Content packs

`loadContentPacks(directory)` reads and validates the JSON definitions in a pack
directory. The default is resolved from the module: repository `packs/` in
development and adjacent `packs/` in a server bundle. `PACKS_DIR` overrides it;
an explicit directory argument takes precedence. It returns definitions, including rank colors;
it does not install them. Duplicate catalog IDs fail validation.

`createContentPackService({ scope, clock })` provides `list(gymId, pagination)`
and `apply(mutationContext, definition)`. The registered endpoints list **installed**
packs and apply a submitted definition, as specified by `ranksContracts`.
Public `GET /api/content-packs/catalog` lists shipped `id`, `name`, `version`,
and `summary` values without reading gym data. The wizard can use it before a
gym exists. An optional v1 `summary` supplies display text; older definitions
without it use their name. Every shipped definition has a summary.

Each application runs in one gym transaction. A unique installation row and row
lock serialize simultaneous applications of the same pack. Entity UUIDs retain
the installation UUIDv7 timestamp and derive their remaining bits from its UUID,
the entity kind, and the pack's stable entity IDs. Keep those IDs stable when
renaming definitions. Different gyms get different installation and entity IDs.

A pack seeds records; after that the gym owns them. Reapplication only restores
records that are missing (for example a deleted rank) and never changes an
existing rank system, rank, program, or class tag, so a gym's own names, colors,
rank order, sub-ranks, criteria, and program flags survive. A restored rank takes
its pack position unless the gym has used that position since, in which case it
goes after the last rank. Application is additive: omitted entities are retained,
since gym records may reference them. Conflicting names or program links cause a
409 and roll back the whole application. Existing class tags with matching names
are reused as shared vocabulary.

Every successful application writes an audit event with the submitted, validated
definition and injected time in the same transaction. Rank colors are nullable
six-digit hex strings in `ranks.color` and rank contracts; a pack without a rank
color stores null. Staff change a gym's colors through the rank update endpoint.
