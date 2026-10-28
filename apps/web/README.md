<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web app

React + Vite + Tailwind CSS for the staff admin, the member portal, the setup
wizard and the kiosk. The shell (providers, routing, the admin layout) is
described in [`src/app/README.md`](src/app/README.md).

## UI conventions

**Mobile-first.** Build every screen for a 360 px wide phone first, then scale
up: Tailwind base classes are the phone layout, and `sm:` / `md:` / `lg:` add
the larger layouts. No screen may scroll sideways, every control is at least
44 px tall (and wide enough to tap), and text stays readable without zooming.
Check each screen you build or change at 360 px and on desktop.

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
and beside it from `sm`. `PageSection` renders an `h2` with optional actions.

**States.** Use the shared states so every screen reports progress the same way:
`LoadingState` (announced to screen readers), `EmptyState` (with the next step as
its action), and `ErrorState` (with `onRetry`; never show server error details).

**Tables.** A wide table becomes stacked rows on phones (`StackedList` and
`StackedItem`, then a table from `md`), or scrolls inside its own
`TableContainer`, a labelled, keyboard-focusable region. The page itself never
scrolls sideways.

**Dialogs.** Editors and confirmations open in a `Dialog` rather than inline below the page, so on a phone they take the whole screen and keep their actions in reach. Show a save error inside the dialog, not only on the page behind it.

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
| `Card`, `Alert`, `Badge` | Grouped content, inline messages, status labels (`tone`: `default`, `success`, `warning`, `destructive`, `muted`) |
| `Input`, `Select`, `Textarea`, `CheckboxField`, `Label` | Form controls |
| `Autocomplete` | One searchable selection input; keyboard arrows, Enter and Escape, selected label, loading/empty feedback; suggestions flow within scrollable dialogs |
| `TableContainer`, `StackedList`, `StackedItem` | Wide tables and their phone layout |
| `Dialog` | A modal open while mounted: full screen on phones, a centered panel from `sm` (`size="wide"` for more room); Escape, the backdrop and close button request dismissal, with inline confirmation for changed inputs; focus returns to the opener. Use `dismissible={false}` or `useDialogOperation` during operations. |

Keep subviews inside the existing dialog. Reviewed flows: invoice receipt,
cash/check, saved-card charge, refund, pay link, card removal/default and review
hold; one-off invoice creation; member/household creation; schedule session edit
and panels, class edit/delete; rank and staff edit; waiver templates/signing;
campaign creation; go-live confirmation; demo guide and outbox preview. Only
invoice actions opened another dialog; they now use integrated views. The demo
guide and outbox preview are separate top-level views, and other dialogs already
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
scrolling, 44 px shell targets, and axe WCAG 2.1 A/AA; `e2e/specs/mobile-screens.spec.ts` checks the admin screens themselves at both widths (whole-page axe, 44 px content targets) and their main flows.
