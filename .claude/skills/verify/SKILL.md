---
name: verify
description: Build/launch/drive recipe for verifying Summa changes at runtime (dev server + Playwright screenshots).
---

# Verifying Summa changes

## Launch

```bash
DATABASE_PATH="$TEMP/claude/summa-verify.db" uv run python -m summa   # background; serves http://localhost:8000
```

Uses a throwaway DB so the user's `invoices.db` stays untouched. Ready when
`curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/` returns 200.

## Drive (browser)

Install the separately pinned screenshot tooling and Chromium once:

```bash
npm run screenshots:setup
```

Then import Playwright from `scripts/screenshots/node_modules` or use the
repository's screenshot tooling. Useful widths: 1280 (desktop), 600 (just under
the 640px sheet breakpoint), 390 and 320 (phones).

Gotchas:

- Sidebar buttons (`[data-action="open-add"]`) are outside the viewport on
  narrow widths — use the keyboard shortcut `n` (opens the add-invoice modal)
  or the FAB (`.fab`) instead.
- Modals animate in (~0.3s slide-up on mobile); `waitForTimeout(500)` after
  `[data-el="add-invoice-modal"].active` before screenshotting.
- Elements are selected via `data-el` attributes, not ids (see
  docs/code-style.md).

## Flows worth driving

- Add/edit invoice modal: open (key `n`), check layout at all four widths;
  overflow check = compare `scrollWidth` vs `clientWidth` on `.modal` and
  `.modal-body`.
- Filter bar / bottom sheet: below 640px filters become a bottom sheet.
