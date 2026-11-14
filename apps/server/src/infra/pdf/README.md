<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# PDF rendering

Validation and rendering diagnostics use the `pdf/pdf` locale namespace through `messages.ts`.

`document.ts` validates uploaded static waiver PDFs and appends generated signing
pages without painting or reflowing the original pages. It uses
`@cantoo/pdf-lib` 2.11.1 (MIT) for parsing and page copying; PDFKit still generates
the signing page. Validation and copying run in process, without network requests
or evaluation, with one active operation and at most eight waiting requests,
including at most two waiting per gym. Excess work receives `rate_limited` (429)
with the `busy` reason and `Retry-After: 1`. Callers pass their gym ID (required) and
lazy storage reads so a refused operation never loads the stored document into memory.
`appendSignaturePdf` renders the signing page before it takes the document slot, so a
full text queue never holds the slot.

The upload envelope is checked before the repair-oriented parser runs: a PDF
header, complete objects and streams, exact cross-reference offsets and a final
EOF are required. Limits are 10 MiB, 20 pages, bounded syntax depth and object
counts, and at most 8 MiB of aggregate object-stream inflation. Compressed syntax
is checked before vendor object construction. Single-revision Word hybrid files,
linearized files with forward cross-reference links, and Flate cross-reference
streams with PNG prediction are accepted. Every section must belong to the final
index, and every physical or compressed object must match that index. Free hybrid
placeholders may resolve to live objects; conflicting live definitions, deleted
definitions, unindexed objects and revised linearized files are refused. The
object walk checks each indirect object once, allowing long bookmark chains and
ordinary bookmark style flags; external-file keys are checked in their stream or
reference-XObject context. References to another reference are refused because the
copying parser and viewer can resolve them differently. Duplicate objects, page-tree cycles/sharing, inconsistent counts, and unsupported stream
encodings are refused. Every parsed dictionary is checked for active actions,
forms, alternate appearances, attachments, optional-content layers and external references.
Plain `Link` annotations may navigate within the document or use HTTP, HTTPS and
email addresses. A `GoTo` open action may select the opening page; a destination
array may do so when its first item is one of the document's own pages. Other annotation
subtypes, action types and action chains are refused; those documents must be flattened. Parser
success alone does not establish that an upload is valid. Refusals for conflicting
revisions or unsupported compression ask for a flattened new copy or a standard
Flate export respectively.

The waiver service separately checks the stored document hash against the
immutable signing snapshot before rendering or serving it. Original pages have
their bounded structural parse checked again, but upload acceptance policy is not
reapplied to signed records. Later policy changes therefore do not invalidate them.
Original pages have no added stamp; the generated details page carries the snapshot hash. Independent
PDF.js text-extraction tests check page order and the signing details.

`renderPdf({ title, createdAt, footer, blocks })` accepts text, image and page-break
blocks and returns PDF bytes. Callers own document meaning, labels, ordering and
hashes. No PDFKit or Fontkit objects cross this boundary.

PDFKit 0.20.2, Fontkit 2.0.4 and bidi-js 1.1.0 are pinned. Fonts are loaded and
SHA-256 verified and parsed individually on first use, then reused. A compact
coverage map selects faces without opening them; Latin-only and Cyrillic-only
documents load only Noto Sans. Each document
has its own subset and a bounded measurement cache. One render runs at a time;
eight requests may wait, and excess requests receive `rate_limited` (429) with the
`busy` reason and `Retry-After: 1`.
Documents are limited to 100 pages, 100,000 text characters and 8 MiB output.

The renderer wraps at word/grapheme boundaries. It applies bidi embedding levels,
mirrored punctuation and visual run positions, shapes whole Arabic runs, and
keeps even-level digits in logical order. It paints runs in logical order at their
visual coordinates for text extraction. Each unsupported code point becomes a
visible U+FFFD replacement from Noto Sans, preserving the surrounding text. The
waiver area rejects unsupported template text before publication; personal names
remain signable and retain their original spelling in the stored snapshot.
This is a plain-text document renderer, not an HTML or rich-text engine.

## Font assets

`fonts/provenance.json` pins every upstream revision and SHA-256. Noto Sans and
Noto Sans Arabic, Hebrew, Thai and Devanagari are unchanged upstream TrueType
files under OFL-1.1. Noto CJK is a **static
weight-400 instance** of the pinned upstream TrueType variable font, retaining
all glyphs. `instantiate-cjk.py` reproduces it with FontTools **4.60.1**, with
timestamp recalculation disabled. Python and FontTools are maintainer tools;
neither is needed to build the app from the checked-in assets or run it.

Install that exact FontTools version in a disposable Python environment, then run
`node apps/server/src/infra/pdf/fetch-fonts.mjs` from the repository root to
reproduce all six files. The script verifies both source and output hashes.
Notices are in `fonts/OFL.txt`, `fonts/CJK-LICENSE.txt` and `THIRD_PARTY_LICENSES`.
The server build copies the assets into `dist/assets/pdf`; path resolution does
not depend on the process working directory.

`node apps/server/src/infra/pdf/coverage.mjs` derives `coverage.json` from the
unchanged font files. Entries carry the pinned file hashes; a test compares every
range against the full font character maps. The metadata is bundled into the
server. The full Noto Sans CJK SC file remains unchanged.

Noto Naskh Arabic was rejected after a Fontkit combining-mark crash. The CJK CFF
font exceeded the repeated-render memory budget; runtime instancing of the
variable TrueType face also failed in Fontkit's subset encoder. Shipping a static
TrueType instance avoids both issues without patching the libraries.

## Verification

The waiver tests independently extract CJK (Chinese, Japanese and Korean),
Cyrillic, two-word Arabic, Arabic with Western and Arabic-Indic digits, Latin
combining marks, Arabic marks, Hebrew (including vowel marks), Thai and Devanagari
using PDF.js 6.4.299. They verify embedded
subsets with system fonts disabled, and rasterize the multilingual fixture.
Generated documents declare PDF 1.5, the first version that allows `ActualText`
in marked content. Devanagari runs carry PDF `ActualText` with their original
reading order, retaining the shaped positions of pre-base vowels. PDF.js 6.4.299 ignores `ActualText` and
extracts those vowels in visual glyph order; its regression checks the complete
glyph inventory and independently decodes the original logical text from the PDF.

`node --max-old-space-size=256 --import tsx src/areas/waivers/pdf-benchmark.ts latin`
from `apps/server` renders 20 pages cold and then ten more times in a fresh
process. Replace `latin` with `mixed` for the multilingual fixture. Build the
same entry with `node src/areas/waivers/pdf-bundle.mjs`, then run
`node --max-old-space-size=256 ../../coverage/waivers/pdf-bundle/server.mjs latin`
(or `mixed`) for the esbuild bundle. Node 24.22.1 on Windows x64 measured this
process high-water RSS on 2026-10-25:

| Entry | Fixture | Cold (MiB) | After ten repeats (MiB) |
| :--- | :--- | ---: | ---: |
| Source | Latin | 135.0 | 174.0 |
| Source | Mixed | 188.8 | 200.1 |
| Bundle | Latin | 128.2 | 165.3 |
| Bundle | Mixed | 149.6 | 191.1 |

The mixed fixture includes Hebrew, Thai and Devanagari in every one of its 20 pages.
The test enforces <300 MiB RSS for the shipped esbuild bundle, run with the
runtime image's allocator defaults (`MALLOC_MMAP_THRESHOLD_=131072`,
`MALLOC_ARENA_MAX=2`) and V8 flags (`PLAINGYM_NODE_FLAGS`), all read from
`deploy/Dockerfile`; source runs
record RSS without a cap because `tsx` compiles in-process. All runs retain the
256 MiB V8 old-space cap and assert <256 MiB heap. It asserts that Latin and
Cyrillic load only Noto Sans; mixed text loads all six faces. These are isolated-renderer measurements, not
whole-install measurements. Combined API/database/backup workloads require
separate checks.
