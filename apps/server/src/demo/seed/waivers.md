<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Demo waivers

`createSeeds({ uploadsFor, clock?, scope? })` in `demo/seed/index.ts` registers
`waiversSeed` immediately after members. Its step ID is `waivers`. It creates a fictional participation
waiver, signed by Marcus Rivera and Elena Petrova, and by Daniel Chen as Ava's
guardian. Other seeded members remain unsigned. All writes go through the waiver
service with the system actor; signatures use an obviously synthetic scribble.
Retries reuse the template and existing signed records.

`runSeeds` creates a **seed-only writable Uploads provider** for the built-in
synthetic images and closes it after the seed run. It uses the configured
persistent storage through `createRuntimeUploads(...).forSeed`. Both sandbox
creation and the seed CLI use this path. The unwrapped provider never reaches
request-facing services.

`demoUploads` permits only server-generated PDFs with content type
`application/pdf` and keys `<gymId>/waivers/<memberId>/pdf/<uuidv7>.pdf`.
Visitor image uploads remain forbidden. The full demo test uses the real S3
adapter against a loopback protocol fixture, follows the returned PDF link,
checks the 403 image-upload response and reruns the real seed CLI.

`core/runtime.ts` configures the waiver routes with the gym's storage, and the seed
composition is wired as well.
