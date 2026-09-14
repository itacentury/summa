# Portfolio (Stocks / ETF tracking) — Implementation Plan

## Context

Summa currently tracks expenses only (invoices + statistics). The user maintains a separate
Excel workbook for their securities depots (Trade Republic, Deka) with one row per week and,
per position, a triple of columns (value · deposit · delta). That spreadsheet should be
replaced by a new top-level **Portfolio** area inside Summa: weekly snapshots per position,
grouped by depot, with value-over-time, invested-vs-value, allocation, biggest weekly movers
and a benchmark line.

The design is final and delivered as `design-reference.html` (anchors `#18a` desktop, `#18b`
mobile, `#18c` empty state + settings) plus a written handoff. It must be recreated **inside
Summa's existing environment** — Jinja partials, plain ES modules, per-component CSS,
vendored Chart.js, Flask blueprints, SQLite — with no framework, no build step, no CSS
framework. The area is strictly separate from the expense side: no shared totals, no shared
filters, its own period state.

Decisions already fixed by the handoff (do not re-litigate): own sidebar entry under an
`INVESTMENTS` group; period switcher `3M / 1Y / YTD / Max`; hero = portfolio value; positions
grouped by depot with subtotals; original currency on the row, all sums in EUR; positions
start at their first snapshot; benchmark from a feed with a silent fallback; empty snapshot
fields carry the previous value forward; no import UI; delta is never stored.

Decisions taken while planning:

- **Benchmark feed:** weekly fetch from a free CSV source (stooq) via a CLI script meant for
  cron; silent fallback to the position flagged `is_benchmark_fallback`.
- **FX on import:** `--fx USD=1.08`-style flag, default `1.0`, documented in `--help`.
- **Snapshot reminder:** dropped from scope (no notification infrastructure exists).
- **XLSX import:** built, with `openpyxl` as a **dev-only** dependency (not in the runtime
  image).

## Shape of the work

Nine parts. Each is a self-contained, reviewable commit that leaves `ruff` / `mypy` /
`pytest` / `npm run lint` green and the app working. Parts 1–3 are backend, 4–8 frontend, 9
the operational tail. Parts within a group are strictly ordered; nothing depends on a later
part.

Every part that touches a cached static asset must bump `CACHE_NAME` in `static/sw.js`
(currently `summa-cache-v201`). New `static/js/*.js` and `static/css/*.css` files are
auto-discovered by the manifest routes in `summa/routes/web.py`, so `sw.js` needs no
asset-list edit — only the version bump.

## Part 1 — Schema and migrations

**Files:** `summa/db.py`, `tests/test_db.py`

Add four tables to `init_db()` in `summa/db.py`, following the existing
`CREATE TABLE IF NOT EXISTS` + inline-`PRAGMA table_info` migration style already used for
`deleted_at` and `category`:

- `portfolio_depots(id, name UNIQUE, sort_order, created_at)`
- `portfolio_positions(id, depot_id FK→depots ON DELETE CASCADE, name, kind, currency,
is_benchmark_fallback, closed_at, sort_order, created_at, UNIQUE(depot_id, name))`
- `portfolio_snapshots(id, position_id FK→positions ON DELETE CASCADE, date, value, deposit,
fx_rate, carried, created_at, UNIQUE(position_id, date))`
- `benchmark_prices(symbol, date, close, PRIMARY KEY(symbol, date))`

Exact DDL is in the handoff README. Plus the two indexes it specifies
(`idx_portfolio_snapshots_position_date`, partial `idx_portfolio_positions_depot`).

Notes:

- Portfolio rows are **not** soft-deleted — `closed_at` on a position means "sold", not
  "hidden". The `deleted_at IS NULL` invariant is an invoice-side rule and must not be
  copy-pasted here.
- **A sale is recorded, not flagged.** A closed position's history ends in a snapshot dated
  exactly `closed_at`, with `value = 0` and `deposit = -(what it was last worth)`. The money
  leaves the portfolio the way it entered, so a sold position drops out of the allocation
  _and_ the totals through its own numbers — the donut always sums to the hero card. The
  negative deposit is what keeps the realized gain: 250 € paid in, sold for 300 € →
  `invested = -50`, `gain = 0 - (-50) = +50`, and `week_delta = 0 - 300 - (-300) = 0`, so the
  sale reads as neither a gain nor a loss. That row is **derived, not stored**: the schema
  keeps only what the user entered, and `with_sale_recorded()` computes the closing row from
  `closed_at` on every read. `PATCH /api/portfolio/positions/<id>` with `{"close": true}`
  therefore only sets the column, and `{"close": false}` only clears it — a close can never
  overwrite the week it was sold in, which makes the round trip exactly reversible.
- Because deposits are signed, **`invested_eur` means net money at work**, not lifetime
  contributions, and goes negative for a position sold at a profit. `gain_pct` is therefore
  measured against the sum of the _positive_ deposits (`contributed_eur`); dividing by the
  net amount would report exactly −100 % for every profitably sold position.
- A closed position never contributes a `week_delta`: no further snapshot is ever recorded
  for it, so its final week would otherwise report itself into "Last week" and the biggest
  movers for good.
- SQLite does not enforce foreign keys unless `PRAGMA foreign_keys = ON`. `get_db()` only sets
  WAL today. Add `PRAGMA foreign_keys = ON` inside `get_db()` so the `ON DELETE CASCADE`
  clauses actually fire; verify the existing invoice tests still pass (they should —
  `invoice_items` already declares the same cascade and the app deletes invoices softly).

**Tests** (`tests/test_db.py`, reusing its `temp_db` fixture and `_columns()` PRAGMA helper):
tables exist with the expected columns; the unique constraints reject duplicates; deleting a
depot cascades to its positions and their snapshots.

## Part 2 — Derivation layer

**Files:** `summa/portfolio.py` (new), `tests/test_portfolio.py` (new)

A pure module with **no Flask and no SQL** — dataclasses plus functions that take rows and
return computed values. This is where every rule from the handoff lives, testable in
isolation:

- `value_eur(value, fx_rate)` → `value / fx_rate`
- `invested_eur(snapshots)` → `sum(deposit / fx_rate)`
- `gain`, `gain_pct` (guard `invested == 0`)
- `week_delta(latest, previous)` →
  `latest.value_eur - previous.value_eur - latest.deposit_eur` — the deliberate difference
  from the Excel Delta column; give it a docstring saying so
- `range_start(range_token, today)` → the `3m | 1y | ytd | max` window start
- `build_series(snapshots_by_position, dates)` → the `portfolio` and `invested` series, each
  position contributing only from its first snapshot onward (never from 0)
- `contributed_eur(snapshots)` → `sum(deposit / fx_rate)` over deposits above zero only —
  the `gain_pct` basis, see the `closed_at` notes in Part 1
- `allocation(positions)` → shares, closed positions excluded, top-5 + aggregated remainder
- `biggest_changes(positions)` → top-3 gainers and top-3 losers by `week_delta`

Dataclasses (`PositionView`, `DepotView`, `PortfolioTotals`, `ChartSeries`) rather than
untyped dicts, per `docs/code-style.md`.

**Tests:** a table-driven `tests/test_portfolio.py` in the style of `tests/test_helpers.py` —
parametrized cases for each derivation, plus explicit cases for "deposit must not read as a
gain", "position starting mid-range does not begin at zero", and "a sold position leaves both
the allocation and the totals while its realized gain stays in the grand total".

Committing this before the API means the numeric logic is proven before any HTTP shape exists.

## Part 3 — Portfolio API blueprint

**Files:** `summa/routes/portfolio.py` (new), `summa/__init__.py`,
`tests/test_portfolio_api.py` (new)

New `portfolio_bp: Blueprint = Blueprint("portfolio", __name__)` registered in `create_app()`
next to `stats_bp`. Every route is gated automatically by the existing `before_request` hook —
nothing to add to `is_public()` in `summa/auth.py`.

Routes (all reading via `with db_cursor()`, writes wrapped in the canonical
`try / with db_cursor() / except sqlite3.Error → error_response("Internal server error", 500)`
shape copied from `add_invoice` in `summa/routes/invoices.py`):

| Route                           | Method | Notes                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/portfolio`                | GET    | `?range=3m\|1y\|ytd\|max&depot=<id\|all>` → depots + positions + subtotals + grand total + allocation + biggest changes + the three chart series + `benchmark_source` / `benchmark_updated_at`                                                                                                        |
| `/api/portfolio/snapshot/new`   | GET    | prefill: active positions per depot, previous value each, suggested next un-snapshotted week                                                                                                                                                                                                          |
| `/api/portfolio/snapshot`       | POST   | `{date, rows:[{position_id, value\|null, deposit\|null}]}`; on a new week `value: null` → carried row (`carried = 1`) and `deposit: null` → 0; on a re-post of an existing week a `null` field preserves what is stored; idempotent per `(position_id, date)` via `INSERT … ON CONFLICT(…) DO UPDATE` |
| `/api/portfolio/positions`      | POST   | create                                                                                                                                                                                                                                                                                                |
| `/api/portfolio/positions/<id>` | PATCH  | rename, kind, currency, depot, close                                                                                                                                                                                                                                                                  |
| `/api/portfolio/depots`         | POST   | create                                                                                                                                                                                                                                                                                                |

Conventions to reuse rather than reinvent:

- Validation: raise `ValidationError` from `summa/helpers.py` and convert with
  `error_response(e.message, 400)` — never `str(e)`.
- Input normalisation: `strip_text()`, `require_non_empty_str()`, `parse_bounded_int()`.
- Range/depot params are read with `request.args.get(...)` and validated against a literal
  allowlist (the `sort_by` pattern in `get_invoices`), never interpolated. `range` degrades
  to the default on an unknown token; `depot` instead rejects a malformed or unknown id with
  a 400, because a filter that silently widens to every depot is indistinguishable from an
  empty one.
- Log an `INFO` line on every successful write, as the invoice routes do.

The benchmark series is assembled here: read `benchmark_prices` for the requested window; if
it is empty or stale, compute the series from the position flagged `is_benchmark_fallback` and
set `benchmark_source: "fallback"`. No error, no toast.

**Tests** (`tests/test_portfolio_api.py`): add a `seed_position` / `seed_snapshot` fixture pair
to `tests/conftest.py` mirroring the existing `seed_invoice`. Cover: response shape per range;
depot filter narrows list, totals, allocation and series; snapshot POST inserts, carries
forward on `null`, is idempotent on re-post and preserves the stored row when a
re-post leaves a field blank; benchmark falls back silently when
`benchmark_prices` is empty; the auth gate rejects unauthenticated calls (extend
`tests/test_auth_gate.py`).

## Part 4 — Sidebar grouping and view switching

**Files:** `templates/partials/sidebar.html`, `templates/partials/portfolio.html` (new),
`templates/index.html`, `static/js/stats.js`, `static/js/portfolio.js` (new),
`static/js/state.js`, `static/js/app.js`, `static/css/sidebar.css`,
`static/css/portfolio.css` (new), `static/sw.js`, `tests/frontend/`

The navigation skeleton and an empty Portfolio view — small, reviewable, and it unblocks
everything after it.

- **Sidebar:** insert group labels `EXPENSES` (above Invoices/Statistics) and `INVESTMENTS`,
  separated by a 1px `--border-strong` divider, then a third
  `<button class="nav-item" data-view="portfolio" title="Portfolio">` with the 24×24 stroke-2
  trend-line icon from the reference (`polyline 3 17 9 11 13 15 21 7` +
  `polyline 21 12 21 7 16 7`). Labels get a `.sidebar-group-label` class styled in
  `sidebar.css`; both labels and the divider must be hidden in the 641–960px icon rail (the
  same media query that hides `.nav-item span`).
- **View switching:** the delegated `.sidebar-nav` listener in `static/js/stats.js` currently
  reads `if (view === "stats") … else showInvoicesView()`, which would treat Portfolio as
  Invoices. Refactor it to a `Map` of `view → show function` and move the three `showXView()`
  functions into a small shared place, so each view module owns only its own body.
  `state.currentView` gains `"portfolio"`; `document.body` gains a `portfolio-mode` class with
  the same chrome-hiding rules `stats-mode` has in `filters.css` and `sidebar.css` (the
  invoice filter row and the mobile search button must not appear on Portfolio).
- **Portfolio state:** add to `state.js` — `portfolioRange` (default `"1y"`), `depotFilter`
  (`"all"`), `collapsedDepots: new Set()`, `expandedPositions: new Set()`, the Chart.js
  instance slots (`portfolioChart`, `allocationChart`), plus the two localStorage keys
  `summa.portfolio.range` and `summa.portfolio.depot`. Restore them in a
  `restorePortfolioPrefs()` step at the top of `init()` in `app.js`, validated against the
  allowed token lists exactly as `restorePageSize()` validates the page size.
- **View partial:** `templates/partials/portfolio.html` as a third sibling in
  `<main class="container">`, `class="portfolio-view is-hidden" data-el="portfolio-view"`, with
  a `visually-hidden` `<h2>` — mirroring `templates/partials/stats.html`. In this part it
  contains only the toolbar shell and the empty state (`#18c`: icon, "No positions yet", body
  copy, one `Add first position` button, no import button anywhere).
- **CSS:** create `static/css/portfolio.css` and link it in `index.html` **after `stats.css`,
  before `utilities.css`** (the order comment there explains why utilities stays last). Follow
  `stats.css`'s structure: primitives first, view-scoped overrides as `.portfolio-view .x`,
  section banner comments, all `@media` rules at the bottom of the file. Use only tokens from
  `variables.css` — never the hex values from the handoff, and never the legacy shim variables.
- Register `setupPortfolioListeners` in the `wiringSteps` array in `app.js` as a **bare named
  reference** (the array uses `step.name` as the failure label).
- Bump `CACHE_NAME`.

**Tests:** a `tests/frontend/portfolio.test.js` (vitest + happy-dom, using the existing
`helpers.js` `jsonResponse` / mount pattern) asserting that switching to Portfolio hides the
other two views, sets the topbar title and toggles the active nav item — and, crucially, that
switching back to Invoices does not inherit the portfolio period, and vice versa.

## Part 5 — Summary cards, toolbar and positions list

**Files:** `templates/partials/portfolio.html`, `static/js/portfolio.js`,
`static/css/portfolio.css`, `static/sw.js`, `tests/frontend/portfolio.test.js`

The bulk of the desktop screen (`#18a`), driven by `GET /api/portfolio` through `apiFetch()`
from `static/js/http.js` (mandatory — no bare `fetch`).

- **Toolbar:** period pill group `3M / 1Y / YTD / Max` (its own state, not the invoice
  Week/Month/Year/All switcher), depot select, spacer, and the single primary button
  `New snapshot`. Changing period or depot writes localStorage and refetches.
- **Summary cards:** grid `1.35fr 1fr 1fr` — hero (portfolio value + gain chip + percent +
  `all-time`), Invested, Last week. Negative values use the danger-subtle token pair.
- **Positions list card:** collapsible depot group headers carrying the subtotal, position rows
  (name + `ETF · EUR` meta, invested, value, gain, percent with the `min-width` right-aligned
  mono grid), the `BENCHMARK FALLBACK` badge, and the footer with the column legend and grand
  total.
- **Row expansion:** clicking a row appends a detail strip (`ORIGINAL`, `FX RATE`, `LAST WEEK`,
  `SNAPSHOTS`) **below** the row without changing the row's own layout — the same rule as the
  invoice list's item expand (`#14a`). Several rows may be open at once; the open set lives in
  `state.expandedPositions`.
- Group collapse state lives in `state.collapsedDepots` and persists for the session only.
- Loading reuses the invoice list's skeleton/spinner treatment; failures call
  `showErrorToast("Failed to load portfolio")` exactly as `loadStats()` does.
- All rendering goes through `escapeHtml()` from `dom.js` for any user-entered name.
- Bump `CACHE_NAME`.

**Tests:** rendering from a fixture payload — group subtotals and grand total appear; a
collapsed group hides its rows; expanding a row adds the strip and leaves the row markup
intact; the depot filter re-requests with the right query string.

## Part 6 — Charts: value over time, allocation, biggest changes

**Files:** `templates/partials/portfolio.html`, `static/js/portfolio.js`,
`static/css/portfolio.css`, `static/sw.js`, `tests/frontend/portfolio.test.js`

Three visualisations, all with the vendored global `Chart` (v4.4.1) and the
destroy-before-recreate discipline `stats.js` uses.

- **Value over time:** a line chart, `tension: 0`, no fill. Portfolio 2.5px solid accent,
  Invested 2px dashed `[5,5]`, Benchmark 2px solid. Legend is hand-built markup in the card
  header (not Chart.js's legend), matching the stats cards. Gridlines and tooltip colours must
  be **literal hex** — Canvas cannot resolve CSS custom properties; add a short comment saying
  so, as `stats.js` does. Footer note renders
  `Benchmark from index feed · last updated <date>` or, when
  `benchmark_source === "fallback"`,
  `Benchmark: own MSCI World SRI (index feed unavailable)` — same styling, no toast, never
  blocking.
- **Axis window:** the x-axis spans `range_start … range_end` from the response, never the first and
  last entry of `series.dates`. A position that started mid-period must not shrink the axis
  (handoff decision 7), and the period arithmetic stays on the backend instead of being
  re-implemented in JS.
- **Allocation:** Chart.js doughnut, 132px, ring thickness 17px, palette `chartColors` from
  `state.js` in order, closed positions excluded. Legend rows: top 5 individually, then an
  aggregated `N more`. Swatch colours are assigned via CSSOM (`el.style.background`) after
  insertion — the strict `style-src` CSP forbids inline style attributes.
- **Biggest changes · last week:** plain DOM, no chart library — name, a 140×8px track with a
  fill scaled to the largest absolute change, and the amount. Gainers use `--chart-2`, losers
  `--chart-3` right-aligned inside the track, separated by a divider. Title stays literally
  "Biggest changes · last week".
- Empty period (positions exist, no snapshots in range): keep the cards, render the existing
  `.stats-empty`-style empty block inside the chart card.
- Bump `CACHE_NAME`.

## Part 7 — New-snapshot form (modal / bottom sheet)

**Files:** `templates/partials/modals/portfolio-snapshot.html` (new), `templates/index.html`,
`static/js/portfolio-snapshot.js` (new), `static/js/app.js`,
`templates/partials/modals/shortcuts-help.html`, `static/css/portfolio.css`, `static/sw.js`,
`tests/frontend/`

The weekly entry flow — the one screen the user repeats.

- A standard `.modal-overlay[data-el="portfolio-snapshot-modal"]` > `.modal.modal-sheet` with
  `.sheet-grabber`, `.modal-header` / `.modal-body` / `.modal-footer`, built from the
  `modal_close_button()` macro in `templates/partials/_macros.html`. Focus trapping, `inert`
  management, backdrop-close, `Esc` and `Ctrl+Enter` come free from `static/js/keyboard.js` as
  long as those classes are used — no registration needed. Mobile bottom-sheet drag comes free
  from `static/js/sheet.js`.
- Prefilled from `GET /api/portfolio/snapshot/new`: date defaults to the next un-snapshotted
  week; rows grouped by depot; column strip `POSITION · VALUE · DEPOSIT · DELTA`.
- Delta is recomputed live as `value − previous_value − deposit`; an empty row shows `carried`
  instead of a number; the footer shows a live `Portfolio after save` total.
- Inputs accept both `1.234,56` and `1234.56` — one shared parse helper, unit-tested.
- Tab order runs value → deposit → next position.
- An `+ Add position` affordance (name, kind, currency, depot) posting to
  `/api/portfolio/positions`, styled with the existing add-invoice field classes.
- Save: optimistic list update, then refetch, then `showNoticeToast`. A duplicate date is
  confirmed before it replaces.
- **FAB:** the existing `.fab` is bound by `[data-action="open-add"]`. Portfolio needs its own
  trigger; give the snapshot FAB `[data-action="open-snapshot"]` and show/hide the two FABs by
  `body.portfolio-mode` in CSS, keeping the existing "hide while a selection is active" rule.
- **Keyboard:** `N` opens New snapshot **while the portfolio view is active** — extend the
  existing `case "n"` in `keyboard.js` to dispatch on `state.currentView` rather than adding a
  second listener. Document it in the shortcuts-help modal.
- Bump `CACHE_NAME`.

## Part 8 — Mobile layout and Settings → Portfolio

**Files:** `static/css/portfolio.css`, `templates/partials/modals/settings.html`,
`static/js/settings.js`, `static/sw.js`

- **Mobile (`#18b`):** same content order, stacked — full-width hero, two small cards side by
  side, full-width period switcher, compact chart card (~110px, Portfolio/MSCI legend only),
  one card per depot with two-line rows (value above, gain/percent below), and the `Show less`
  expanded variant. All rules go in the `@media (width <= 640px)` block at the bottom of
  `portfolio.css`, matching `stats.css`'s convention. Charts keep pixel heights — no viewport
  units.
- **Settings → Portfolio** section in `templates/partials/modals/settings.html`: rows for
  **Depots** (`Manage`), **Positions** (`Manage`) and **Benchmark** (select). The snapshot
  reminder row is intentionally omitted. `Manage` opens a small list editor rendering the
  existing `PATCH /api/portfolio/positions/<id>` and `POST /api/portfolio/depots` endpoints.
- Bump `CACHE_NAME`.

## Part 9 — XLSX import script and benchmark feed job

**Files:** `scripts/import_portfolio_xlsx.py` (new), `scripts/fetch_benchmark.py` (new),
`pyproject.toml`, `tests/test_import_portfolio.py` (new), `CLAUDE.md`

Two operational CLIs, deliberately last — by now the schema and the derivations are proven.

- `openpyxl` goes into the **dev** dependency group in `pyproject.toml` (the runtime Docker
  image must not carry it), and `scripts` is added to `[tool.mypy] files` so the new modules
  are strict-checked. Both scripts use `argparse`.
- **`import_portfolio_xlsx.py`:** reads the wide layout — row 1 depot bands spanning column
  ranges (`Trade Republic Depot` from column B, `Deka Depot` from column W), row 2 headers,
  row 3+ one week each, column A `Datum` as `DD.MM.YY`; per position a triple
  value · `Einzahlung` · `Delta`. Rules: the depot band determines `depot_id`; the row-2 header
  is the position name with a trailing currency token stripped and used as `currency`
  (`FTSE All-World USD` → name `FTSE All-World`, currency `USD`); **Delta columns are discarded
  and recomputed**; empty cells _before_ a position's first value are skipped (that first value
  defines its start date); empty cells _after_ it insert `carried = 1` rows; German number
  format (`1.131,16 €`) is parsed. `kind` defaults: `etf` for names containing
  MSCI/Stoxx/FTSE/UCITS, `fund` for Deka/BGF, else `stock`. `--fx USD=1.08` (repeatable) sets
  the FX rate per currency, default `1.0`, documented in `--help`. `INSERT OR IGNORE` on
  `(position_id, date)` makes a re-run safe. Prints a summary (depots, positions, snapshot
  rows, skipped).
- **`fetch_benchmark.py`:** fetches the weekly index series from stooq's CSV endpoint, upserts
  into `benchmark_prices`, prints what it wrote, and exits non-zero on failure so cron can
  report. The API side already falls back silently, so a failed run degrades the chart footnote
  and nothing else.
- The pure parsing functions (number parsing, header→name/currency split, band→depot mapping,
  kind inference) live at module level and are unit-tested in `tests/test_import_portfolio.py`
  against a workbook built in-memory with `openpyxl` — no fixture binary in the repo.
- `CLAUDE.md` gains a short paragraph on the portfolio area and both scripts.

## Verification

Per part:

```bash
uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest
npm run lint
```

End to end, once Parts 4–7 are in — the `verify` recipe (dev server without `--env-file`, so
the login gate is off):

```bash
uv run python -m summa            # http://localhost:8000
```

Then drive it with Playwright and compare against `screenshots/18a-desktop.png`,
`18b-mobile.png`, `18c-empty-and-settings.png`:

1. Empty state: no positions → "No positions yet" card, no import button anywhere.
2. Seed data via `scripts/import_portfolio_xlsx.py` (or a handful of API calls), reload.
3. Desktop 1180px: hero, chart with three series, depot groups with subtotals, allocation
   donut, biggest changes. Collapse a group, expand a row — the row's own layout must not
   shift.
4. Switch Invoices ↔ Portfolio: the period state must not leak in either direction; the invoice
   filter chrome must be gone on Portfolio.
5. Reload: `portfolioRange` and `depotFilter` restore from localStorage; the invoice page size
   is untouched.
6. Mobile 390px: stacked order, two-line rows, FAB in the invoice-FAB position, snapshot sheet
   with sticky footer and ≥44px inputs.
7. `N` on Portfolio opens New snapshot; `N` on Invoices still opens New Invoice; `Esc` closes
   both.
8. Save a snapshot, then re-post the same date — the second save updates rather than
   duplicating.
9. Empty `benchmark_prices`: the footnote reads "index feed unavailable", no toast, chart still
   renders.
10. Hard-reload twice to confirm the bumped `CACHE_NAME` served fresh assets.
