<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web app

React + Vite + Tailwind CSS for the staff admin, the member portal, the setup
wizard and the kiosk. The shell (providers, routing, the admin layout) is
described in [`src/app/README.md`](src/app/README.md).

Vite embeds the Git version and commit. The root route checks `/healthz` before
navigation in admin, portal and kiosk; a different server identity reloads the page.
A second mismatch stops admin and portal navigation rather than repeatedly reloading stale assets.
A link's preload doesn't run the check, and `pnpm dev` turns it off.
Navigation and kiosk requests share successful checks for a minute; after a failed or timed-out check,
the next attempt waits ten seconds. A pending reload blocks kiosk credentials.
If reloading leaves the tablet on an older bundle, check-in remains available
with a notice asking staff to reload the tablet. A fragment-only destination also reloads the bundle;
removing a fragment replaces the URL before reloading, without leaving a trailing `#`.
The portal worker keeps no offline page or API cache. Settings → Updates displays
the same identity. See [versioning](../../docs/versioning.md).

## UI conventions

**Display counts.** Format numeric counts with `src/lib/count.ts` before passing
them to `t()` or rendering them. It uses the fixed `en` locale, like money and dates. Keep form
values, keypad digits, identifiers (including invoice numbers and card digits),
and legal-record timestamps unchanged. Choose singular/plural messages using
the numeric value before formatting.

Vitest pins the default number and date locale to `en` in `test/locale.ts`; CI runs the
suite with a German system locale to catch accidental locale dependencies.

**Mobile-first.** Build every screen for a 360 px wide phone first, then scale
up: Tailwind base classes are the phone layout, and `sm:` / `md:` / `lg:` add
the larger layouts. No screen may scroll sideways, every control is at least
44 px tall (and wide enough to tap), and text stays readable without zooming.
Check each screen you build or change at 360 px and on desktop.

**Text.** Put application text in `locales/en/<area>/<part>.json` and render it
through `t()`. ESLint rejects literal JSX text, text attributes (including
component text props such as `closeLabel` or `message`), and literal
branches, concatenations or template text rendered in JSX, plus text and text
attributes passed to server `h()` / `jsx()` / `createElement()` templates. Translation keys belong in calls to
`t()`, rather than text props. User-entered names, punctuation, numeric keypad
digits, and decorative symbols are allowed. Emails and PDF builders also use
the catalog and require review when changed.

Settings-section registrations may supply a `listed` React hook returning a boolean.
The settings page calls it in a separate component for each permitted, enabled section,
so hooks can fetch feature-specific availability without coupling the page to a section ID.
Omitting it lists the section by default. The empty state appears only when no section renders.
The section menu uses the same availability hooks, wraps on phones, and links to
each section. Gym details comes first; go-live comes after the configuration sections.
The page scrolls to and focuses a section named in the URL hash once that section
renders, including links from the dashboard and sections whose availability loads later.
It follows layout changes while the other sections load, then yields on the first
pointer, keyboard, wheel, or touch interaction so it does not interrupt editing.
Gym details owns the one brand-color control. The Website section links there
and clears legacy website accents on save; the website uses a tint of the brand color.
The Website section provides the logo upload and stays available while the site
is off, so it can be prepared before publishing. Gym details preserves the logo
on save and has no raw logo reference input.

An empty gym's dashboard offers links to classes, plans, member entry or import,
and the go-live checklist for staff allowed to manage go-live. It uses the existing
readiness read and disappears when the roster has members, including inactive ones.
Failure `Alert`s use `variant="error"`. Set `focusOnReveal` on submit errors to
scroll into view and receive focus when the rendered message changes; without it, an
error leaves focus alone, including background read failures inside forms. Neutral status messages leave focus alone.
`Alert` derives its announcement role from the variant (`status` for info, `alert`
for error); callers can override it for a note. A conditional variant can keep
`focusOnReveal` enabled: it focuses only errors.

`lib/use-draft.ts` keeps field edits across refetches, lets untouched fields follow
the server, and reports conflicts on edited fields. Its optional normalization
mapper compares stored and typed values without changing what the user types.
Admin member forms, rank definitions, and portal household and member forms use it.

**Layout.** The admin shell supplies the header, the navigation (a menu on
phones, a sidebar from `md`), and the page gutters. A page renders its content
inside one `Page` and starts with one `PageHeader`:

```tsx
<Page>
  <PageHeader title={t('members/list:title')} actions={<Button>{t('members/list:add')}</Button>} />
  <PageSection title={t('members/list:recent')}>…</PageSection>
</Page>
```

`PageHeader` renders the page's only `h1`; actions sit below the title on phones
and tablets and beside it from `lg`. `PageSection` renders an `h2` with optional actions. `Page`, `PageHeader` and `PageSection` set `wrap-anywhere` (`overflow-wrap: anywhere`),
which its descendants inherit (tables keep their natural widths), so a long name with no break opportunity (a class, plan or member name) wraps
instead of widening a flex or grid item; `break-words` does not shrink those, and a leftover one overrides the inherited rule, so don't repeat it per element.
App labels stay whole: `Button` and `Badge` reset the rule with `wrap-normal` (and `Badge` is `shrink-0`), so a status badge or button beside a long name keeps
its word. A button whose text carries a user-supplied name (such as "Edit {name}") adds `wrap-anywhere`; `Autocomplete` options set it themselves. A screen
rendered outside a `Page` (the billing catalog) applies the exported `userNames` rule on its own root. Put a table in `TableContainer` so it scrolls instead of widening the page.

**States.** Use the shared states so every screen reports progress the same way:
`LoadingState` (announced to screen readers), `EmptyState` (with the next step as
its action), and `ErrorState` (with `onRetry`; never show server error details).

**Tables.** A wide table becomes stacked rows on phones (`StackedList` and
`StackedItem`, then a table from `md`), or scrolls inside its own
`TableContainer`, a labelled, keyboard-focusable region. The page itself never
scrolls sideways.

**Dialogs.** Editors and confirmations open in a `Dialog` rather than inline below the page, so on a phone they take the whole screen and keep their actions in reach. Show a save error inside the dialog, not only on the page behind it. A `Dialog` has one scroll container, its body: the dialog element clips (`overflow-hidden`) and its header stays put, so don't add a second max height around the whole content; give only a bounded list inside it a `max-h-*` with `overflow-y-auto`.
Tab and Shift+Tab wrap between its visible, enabled controls; closing restores the opener's focus.

**Forms.** `Input`, `Select` and `Textarea` are 44 px tall with 16 px text, so
phones don't zoom into fields. Wrap checkboxes in `CheckboxField` so the whole
row is the touch target. Every control has a visible `Label`.

**Components** live in `src/components/ui` and never take app data or call the
API:

| Component | Use |
| :--- | :--- |
| `Button` | Variants `default`, `secondary`, `outline`, `ghost`, `destructive`, `link`; sizes `default`, `sm`, `icon` (all 44 px tall; give `icon` buttons an `aria-label`) |
| `Page`, `PageHeader`, `PageSection` | Page container, title and actions, titled sections |
| `LoadingState`, `EmptyState`, `ErrorState` | Loading, empty and failed states |
| `Card`, `Alert`, `Badge` | Grouped content, inline messages (`Alert` `variant`: `info`, the default, or `error` for a failure, with the destructive colours and an icon; `FormMessage` shows a form's result and scrolls to and focuses an error, as `useRevealed` does for any element), status labels (`tone`: `default`, `success`, `warning`, `destructive`, `muted`) |
| `Input`, `Select`, `Textarea`, `CheckboxField`, `Label` | Form controls |
| `Autocomplete` | One searchable selection input; keyboard arrows, Enter and Escape, selected label, loading/empty feedback; suggestions flow within scrollable dialogs |
| `TableContainer`, `StackedList`, `StackedItem` | Wide tables and their phone layout |
| `Dialog` | A modal open while mounted: full screen on phones, a centered panel from `sm` (`size="wide"` for more room); Escape, the backdrop and close button request dismissal, with inline confirmation for changed inputs; focus returns to the opener. Use `dismissible={false}` or `useDialogOperation` during operations. |
| `DialogActions` | Sticky actions within a dialog's scrolling body; keep them inside their form so native submission and validation still work |
| `Pager` | Previous/Next for a list, hidden on one page; supply offset, total, limit and onChange, plus disabled during an operation |

Keep subviews inside the existing dialog. Reviewed flows: invoice receipt,
cash/check, saved-card charge, refund, pay link, card removal/default and review
hold; one-off invoice creation; member/household creation; schedule session edit
and panels, class edit/delete; rank and staff edit; waiver templates/signing;
campaign creation; go-live confirmation; demo menu and outbox preview. Only
invoice actions opened another dialog; they now use integrated views. The demo
menu and outbox preview are separate top-level views, and other dialogs already
contain their forms or steps. Busy saves/payments block dismissal; changed form
inputs require explicit discard confirmation before dismissal.
Fields from a finished or discarded subview stop counting as drafts when the
subview unmounts. A form that stays mounted calls `useDialogSaved()(formElement)`
after a successful save, clearing only that form's draft markers and preserving
edits in other forms in the same dialog.
| `MenuIcon`, `CloseIcon`, `UserIcon`, … | Small inline icons, decorative unless labelled |

**Tokens.** Colors are design tokens in `src/app/styles.css` (`bg-primary`,
`text-muted-foreground`, `border-border`, `bg-destructive`, `text-success`, …);
never use raw hex colors or Tailwind palette colors in screens. Type uses
Tailwind's scale: page titles `text-2xl font-semibold` (via `PageHeader`),
section titles `text-lg font-semibold`, body `text-base`, secondary text
`text-sm text-muted-foreground`. Spacing uses Tailwind's scale: `space-y-6`
between page sections, `gap-3` within groups, cards `p-4 sm:p-6`.

**Strings and accessibility.** All visible text goes through `t()`. Interactive
elements are real buttons and links with accessible names. The production-image
e2e suite (`e2e/specs/mobile.spec.ts`) checks the admin shell at 360 px and
desktop width: every admin page reachable through the menu, no sideways
scrolling, 44 px shell targets, and axe WCAG 2.1 A/AA; `e2e/specs/mobile-admin-{phone,desktop}.spec.ts` check the admin screens themselves at both widths (whole-page axe, 44 px content targets) and their main flows.

## API answer compatibility

Staff and portal API consumers use `lib/response.ts` to parse JSON answers. It strips fields the
shared schema identifies as unknown, including nested records, so an open tab
can read an answer with newly added fields. Required fields, field types and
refinements still apply. Request validation and the OpenAPI schemas remain strict.
Kiosk lookup and check-in answers remain strict to reject unexpected private fields
on shared devices.

Emailed pay links, staff invitations and portal invitations keep pending send generations in tab-local session storage across reloads, keyed by the form and request identity. Confirmed sends clear the generation. An uncertain replay displays a warning and a Send again action; that deliberate action chooses a new generation. If the browser blocks session storage, retries retain their generation only while the form stays mounted.

Display timestamps through `src/lib/instant.ts`: `useGymTime()` reads the gym's
bootstrap timezone, while presentational components can pass the zone explicitly.
Formatters are cached by style, zone and locale. Calendar dates use
`calendarDateLabel` and month ranges use `monthLabel`, so the browser's timezone
cannot move them to another day. Admin schedule labels use the same locale clock
as the portal (`6:30 AM` in English), including weekly-class summaries through
`wallTimeLabel`; time inputs still use `HH:MM`.
Kiosk class pickers also use the bootstrap gym zone and English locale, including
when the tablet is set to a different day. Failed camera enumeration offers
Try again and Name and PIN; demo device-token save failures offer Try again
without reopening the link.
