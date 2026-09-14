# Handoff: Portfolio (Stocks / ETF tracking) for Summa

## Overview

A new top-level **Portfolio** area for Summa (github.com/itacentury/summa) that replaces the user's Excel depot sheet: weekly snapshots of value and deposit per position, grouped by depot (Trade Republic, Deka), with value-over-time, invested-vs-value, allocation, biggest weekly movers, and a benchmark line. Strictly separate from the existing expense/invoice side — no shared totals, no shared filters.

## About the design files

`design-reference.html` in this bundle is a **design reference created in HTML** — a prototype showing intended look and behavior, not production code to copy. The task is to **recreate these designs inside Summa's existing environment**: Jinja templates in `templates/partials/`, plain ES modules in `static/js/`, component stylesheets in `static/css/`, Chart.js (already vendored at `static/js/vendor/chart.umd.min.js`), Flask blueprints in `summa/routes/`, SQLite via `summa/db.py`. Follow those patterns — do not introduce a frontend framework, build step, or CSS framework.

Open `design-reference.html` and jump to the anchors `#18a` (desktop), `#18b` (mobile), `#18c` (empty state + settings). `#15c`/`#17b` are superseded (17b's import dialog was dropped in favour of a one-off script; see "Data import"). Screenshots of 18a/18b/18c are in `screenshots/`.

## Fidelity

**High-fidelity.** Colors, type, spacing and copy are final and use Summa's existing Warm Sand tokens from `static/css/variables.css`. Recreate pixel-faithfully with those CSS variables — do not hardcode the hex values listed below; they are given so you can verify you picked the right token.

---

## Decisions already made (do not re-litigate)

1. Own sidebar entry **Portfolio**, not a tab inside Statistics.
2. Sidebar gets group labels: **EXPENSES** (Invoices, Statistics) — divider — **INVESTMENTS** (Portfolio). Makes clear that "Statistics" refers to invoices only.
3. Period switcher is Portfolio-specific: **3M / 1Y / YTD / Max** (the invoice Week/Month/Year/All switcher is not reused).
4. Hero metric: **portfolio value**, gain/loss absolute + % underneath.
5. Positions are **grouped by depot with a subtotal per group**; groups are collapsible.
6. Original currency is shown on the position row; **all sums are EUR**.
7. Positions appear **only from their first snapshot**; their line starts there (not at 0), the chart axis still spans the full selected period.
8. Benchmark comes from a **weekly server-side index feed**, with a **silent fallback** to the user's own MSCI World SRI ETF and a small note under the chart.
9. Empty snapshot fields **carry the previous value forward**; empty deposit = 0.
10. **No import UI.** The existing Excel history is migrated once by a script. The only data-entry path in the app is "New snapshot" + adding positions.
11. Delta is never stored — always derived from consecutive snapshots.
12. **A sale is recorded, not flagged.** Closing a position writes a final snapshot dated exactly `closed_at`, `value = 0`, `deposit = −(what it was last worth)`. A sold position therefore leaves the allocation _and_ the totals through its own numbers, so the donut always sums to the hero card, while keeping its history and its realized gain.

---

## Data model (new tables, `summa/db.py` → `init_db()`)

```sql
CREATE TABLE IF NOT EXISTS portfolio_depots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,           -- 'Trade Republic', 'Deka'
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portfolio_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    depot_id INTEGER NOT NULL,
    name TEXT NOT NULL,                  -- 'MSCI World SRI'
    kind TEXT NOT NULL,                  -- 'etf' | 'fund' | 'stock'
    currency TEXT NOT NULL DEFAULT 'EUR',-- ISO-4217, e.g. 'USD'
    is_benchmark_fallback INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT DEFAULT NULL,         -- sold; dates the zeroing snapshot (decision 12)
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (depot_id) REFERENCES portfolio_depots (id) ON DELETE CASCADE,
    UNIQUE (depot_id, name)
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL,
    date TEXT NOT NULL,                  -- ISO 'YYYY-MM-DD', one per week in practice
    value REAL NOT NULL,                 -- in the position's own currency
    deposit REAL NOT NULL DEFAULT 0,     -- money added that week, same currency
    fx_rate REAL NOT NULL DEFAULT 1.0,   -- units of position currency per EUR at that date
    carried INTEGER NOT NULL DEFAULT 0,  -- 1 = value copied forward, not user-entered
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (position_id) REFERENCES portfolio_positions (id) ON DELETE CASCADE,
    UNIQUE (position_id, date)
);

CREATE TABLE IF NOT EXISTS benchmark_prices (
    symbol TEXT NOT NULL,                -- e.g. 'URTH' or whatever feed symbol is used
    date TEXT NOT NULL,
    close REAL NOT NULL,
    PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_position_date
    ON portfolio_snapshots (position_id, date);
CREATE INDEX IF NOT EXISTS idx_portfolio_positions_depot
    ON portfolio_positions (depot_id) WHERE closed_at IS NULL;
```

**Derived values (never stored):**

- `value_eur = value / fx_rate` (EUR positions have `fx_rate = 1.0`).
- `invested_eur` per position = sum of `deposit / fx_rate` over all its snapshots. Deposits are signed, so this is the **net money at work**, not lifetime contributions: a sale enters as a negative deposit and takes its proceeds back out, leaving a profitably sold position below zero.
- `contributed_eur` per position = the same sum over the **positive** deposits only.
- `gain = value_eur − invested_eur`; `gain_pct = gain / contributed_eur * 100`. **The basis matters**: dividing by `invested_eur` would report exactly −100 % for every profitably sold position, whose net invested is the negation of its gain. For a position never sold from, the two sums are equal.
- `week_delta` = `value_eur` of latest snapshot − `value_eur` of previous snapshot − `deposit_eur` of latest snapshot (so a deposit does not read as a gain). **This matters**: the user's Excel Delta column mixes deposits in; the app must not. The same subtraction makes a sale read as neither gain nor loss (`0 − 300 − (−300) = 0`). A **closed** position contributes no `week_delta` at all — no further snapshot is ever recorded for it, so its final week would otherwise report itself into "Last week" and the biggest movers for good.
- Depot subtotal / grand total = sums of the position values and invested amounts.

## API (new blueprint, e.g. `summa/routes/portfolio.py`)

- `GET /api/portfolio?range=3m|1y|ytd|max&depot=<id|all>` → depots with positions (name, kind, currency, native value, EUR value, invested, gain, gain_pct, week_delta, first_snapshot_date, snapshot_count), subtotals, grand total, allocation shares, biggest changes, and the three chart series (`portfolio`, `invested`, `benchmark` + `benchmark_source: "feed" | "fallback"`, `benchmark_updated_at`).
- `GET /api/portfolio/snapshot/new` → the prefill for the entry form: active positions per depot, previous value per position, suggested date (next un-snapshotted week).
- `POST /api/portfolio/snapshot` → `{date, rows: [{position_id, value|null, deposit|null}]}`. `value: null` inserts a carried row (previous value, `carried = 1`); `deposit: null` → 0. Idempotent per `(position_id, date)` — re-posting the same date updates.
- `POST /api/portfolio/positions`, `PATCH /api/portfolio/positions/<id>` (rename, kind, currency, depot, close), `POST /api/portfolio/depots`.
- Weekly benchmark refresh: server-side job/cron that appends to `benchmark_prices`. On failure, the API returns the fallback series computed from the position flagged `is_benchmark_fallback` and sets `benchmark_source: "fallback"` — no error toast, no blocking.
- Reuse the existing auth gate and rate limiting used by the invoice endpoints.

## Data import (one-off, not a feature)

Write `scripts/import_portfolio_xlsx.py` (openpyxl; the project is already Python/uv):

- Input: the user's depot workbook. Layout is **wide**: row 1 holds coloured depot bands spanning column ranges (`Trade Republic Depot` starting at column B, `Deka Depot` starting at column W); row 2 holds headers; from row 3 each row is one week. Column A is `Datum` (`DD.MM.YY`).
- Per position a **triple of columns**: value · `Einzahlung` · `Delta`.
- Rules: depot band determines `depot_id`; header text in row 2 is the position name (strip a trailing currency token and use it as `currency`, e.g. `FTSE All-World USD` → name `FTSE All-World`, currency `USD`); **Delta columns are discarded and recomputed**; empty cells _before_ a position's first value are skipped (that first value defines the start date); empty cells _after_ it insert `carried = 1` rows; German number format (`1.131,16 €`) must be parsed.
- `kind`: default `etf` for names containing MSCI/Stoxx/FTSE/UCITS, `fund` for Deka/BGF, else `stock`; the user can fix it in Settings afterwards.
- `fx_rate`: the workbook has no FX column — write `1.0` and let the user correct the few USD rows, or accept a `--fx USD=1.08` flag. Document whichever you choose in the script's `--help`.
- Idempotent: `INSERT OR IGNORE` on `(position_id, date)` so a re-run is safe. Print a summary (depots, positions, snapshot rows, skipped).

---

## Screens

### 1. Portfolio — desktop (`#18a`)

**Purpose:** see what the portfolio is worth, how it developed, and per-position detail.

**Layout:** existing app shell. Sidebar 200px (`--bg-sidebar` `#ebe2d0`, right border `--border-strong` `#ddd2ba`), content area `padding: 20px 24px`, vertical `flex` with `gap: 16px`.

**Sidebar (edit `templates/partials/sidebar.html`):** logo row unchanged (`static/icons/icon-96.png`, 26px). Then group label `EXPENSES` (9.5px / 700 / `letter-spacing: .1em` / `--text-faint` `#a3947a`, padding `0 11px 5px`), nav items Invoices and Statistics, a `1px` divider `#ddd2ba` with `margin: 12px 11px 11px`, group label `INVESTMENTS`, then the Portfolio nav item (`data-view="portfolio"`). Active nav item keeps the existing treatment: `--bg-card` `#fdf9f1`, `box-shadow: 0 1px 3px rgb(90 70 40 / 8%)`, weight 700, icon stroked in `--accent` `#c98d6b`. Portfolio icon: 24×24 viewBox, `polyline 3 17 9 11 13 15 21 7` + `polyline 21 12 21 7 16 7`, stroke-width 2.

**Toolbar row** (`display:flex; align-items:center; gap:10px`):

- Period pill group: container `--bg-card`, `1px solid --border-color` `#e2d8c2`, `radius --radius-lg` 12px, `padding: 4px`, inner gap 2px. Items `padding: 8px 15px`, `radius 8px`, 12.5px. Inactive `--text-muted` `#8a7c62`; active `--accent` background, `--accent-text-on` `#fdf9f1`, weight 600. Labels `3M`, `1Y`, `YTD`, `Max`.
- Depot select: height 42px, `padding: 0 13px`, `--bg-card`, `1px solid --border-color`, radius 12px, 12.5px `--text-secondary` `#6b5f4a`, chevron 10px `#a3947a`. Options: All depots / Trade Republic / Deka.
- Spacer `flex: 1`.
- Primary button **New snapshot**: height 42px, `padding: 0 15px`, `--accent` background, radius 12px, 12.5px/600 `#fdf9f1`, plus-icon 13px stroke-width 2.5, `white-space: nowrap`. This is the only action button in the toolbar.

**Summary cards** — `display:grid; grid-template-columns: 1.35fr 1fr 1fr; gap: 14px`:

1. _Portfolio value_ — background `#e7dcc6` (the existing `.stat-card-total` treatment), radius 14px, `padding: 17px 20px`. Label 10.5px/700/`.09em`/`#8a7c62`. Value JetBrains Mono 30px/600, `letter-spacing: -.01em`, `margin-top: 9px` → `€ 16,810.72`. Below (`margin-top: 11px`, flex gap 9px): gain chip `padding: 4px 9px`, background `--success-subtle` `#d7e4d2`, radius 7px, Mono 12px/700 `--success` `#54744a` → `+1,005.72 €`; then `+6.4 %` (12px/700 `#54744a`); then `all-time` (11.5px `#8a7c62`).
2. _Invested_ — `--bg-card`, `1px solid --border-color`, radius 14px. Value Mono 24px/600 `--amount` `#7c6b3f` → `€ 15,805.00`. Sub-line 11.5px `#8a7c62` → `9 positions · 2 depots`.
3. _Last week_ — same card style. Value Mono 24px/600 `#54744a` → `+336.04 €`. Sub-line → `snapshot 06.09.2026`.
   Negative values use `--danger-subtle-text` `#9c5b4a` and a `--danger-subtle-bg` `#eed9d3` chip.

**Value over time card** — `--bg-card`, `1px solid --border-color`, radius 14px.

- Header `padding: 14px 20px`, bottom border `--border-subtle` `#efe7d5`: title 13.5px/700 `Value over time`, spacer, then three legend items (11px `#6b5f4a`, 14×2px colour bar, radius 2px): Portfolio `--accent` `#c98d6b`, Invested `#b5a184` (`--chart-4`), MSCI World `#a3c2c2` (`--chart-7`).
- Chart body `padding: 14px 20px 8px`, height 200px. Implement with **Chart.js** (line, no fill, `tension: 0`), gridlines `#efe7d5`, no y-axis labels in the mock — keep Chart.js' default subtle y ticks if you prefer, but stay within the palette. Series: Portfolio 2.5px solid; Invested 2px dashed `[5,5]`; Benchmark 2px solid. x labels Mono 10.5px `#a3947a` (`Oct 25 … Sep 26`).
- Footer note: 10.5px `#a3947a`, info icon 11px → `Benchmark from index feed · last updated 06.09.2026`. When the feed failed: `Benchmark: own MSCI World SRI (index feed unavailable)` — same styling, no toast.

**Positions list card** — `--bg-card`, `1px solid --border-color`, radius 14px, `overflow: hidden`.

- _Group header_ (clickable, collapses the group): `padding: 11px 20px`, background `--bg-hover` `#f9f4e8`, bottom border `#efe7d5`. Chevron 11px `#8a7c62` stroke-width 2.5 (rotates when collapsed); label 11px/700/`.08em`/`#8a7c62` → `TRADE REPUBLIC · 7 POSITIONS`; subtotal Mono 13px/600; 12px gap; gain Mono 12px/700 `min-width: 92px` right-aligned; percent 11.5px/700 `min-width: 54px` right-aligned.
- _Position row_: `padding: 11px 20px`, bottom border `#f3ede2`, `display:flex; align-items:center; gap:12px`:
  1. name block `flex:1; min-width:0` — name 13px/600 (ellipsis), meta 11px `#a3947a` `margin-top:1px` → `ETF · EUR`, `ETF · USD · since 01.03.2026`, `Stock · EUR`.
  2. invested Mono 12px `#8a7c62`, `min-width: 88px`, right.
  3. value Mono 13px, `min-width: 96px`, right.
  4. 12px spacer.
  5. gain Mono 12px/700, `min-width: 92px`, right, `#54744a` / `#9c5b4a`.
  6. percent 11.5px/700, `min-width: 54px`, right.
     The benchmark-fallback position carries a badge after its name: `padding: 2px 7px`, background `--cat-baecker` `#f0ddc8`, radius 999px, 9.5px/700/`.06em`, colour `--cat-baecker-text` `#93683a` → `BENCHMARK FALLBACK`.
- _Expanded row_ (click toggles): row background becomes `#f9f4e8`; detail strip below the row, `display:flex; gap:28px`, `padding-bottom: 12px`; each item label 10px/700/`.07em`/`#a3947a` and value Mono 12.5px: `ORIGINAL` (`USD 412.50`), `FX RATE` (`1.0800`), `LAST WEEK` (`+5.12 €`, coloured), `SNAPSHOTS` (`27`). Structure of the row itself must not change while expanding (same rule as the invoice list: keep the row layout, only append the strip).
- _Footer_: `padding: 10px 20px`, background `#f9f4e8`, top border `#efe7d5`, 11.5px `#8a7c62` left text `Columns: position · invested · value · gain/loss`, then total invested Mono, 12px spacer, grand total Mono 13px/700 `#3a332a` `min-width: 96px` right.

**Bottom row** — `display:grid; grid-template-columns: 1fr 1fr; gap: 14px`:

- _Allocation_: header `padding:14px 20px` + border, title 13.5px/700. Body `display:flex; align-items:center; gap:18px; padding:16px 20px`. Donut: Chart.js doughnut, 132px, ring thickness 17px, palette `--chart-1 … --chart-8` in order, closed positions excluded. Legend: one row per position (11.5px), 9×9px swatch radius 2px, name `flex:1` with ellipsis, percentage `#8a7c62`; top 5 individually, then `4 more` aggregated in `#8a7c62`.
- _Biggest changes · last week_: same card chrome. Four rows (`gap: 11px`): name 12.5px `flex:1`; bar track 140×8px background `--bg-primary` `#f3ede2` radius 999px with fill `--chart-2` `#a8bfa0` (gainers) scaled to the largest absolute change; amount Mono 12px/700 `min-width: 72px` right. Losers sit under a `1px #efe7d5` divider, bar fill `--chart-3` `#d9a48a` and right-aligned inside the track. Show top 3 gainers + top 3 losers (fewer if there aren't that many); title wording is deliberately plain — do not call it "Movers".

### 2. Portfolio — mobile (`#18b`)

Breakpoint behaviour follows the existing app (top bar + drawer). Same content order, stacked:

- Hero card full width (Mono 25px value, chips 11.5px).
- Two small cards side by side (`flex: 1` each): Invested, Last week — label 9.5px/700, value Mono 15px/600.
- Period switcher full width, each segment `flex: 1`, `padding: 9px 0`, centred, 12px.
- Chart card `padding: 13px 15px`, chart height ~110px, compact legend (Portfolio / MSCI), footer note 9.5px.
- One card per depot: group header as on desktop (10px label, Mono 12px subtotal); rows two-line — left: name 12.5px/600 + `1,300.00 € invested` (Mono 10.5px `#a3947a`); right: value Mono 12.5px/600 and below it `+89.27 € · +6.9 %` (Mono 10.5px/700, coloured).
- Expanded mobile row: background `#f9f4e8`, `Show less` link (`--accent-text` `#a5643c`, 600) in the meta line, detail items in a `flex-wrap` grid `gap: 8px 22px` (labels 9px, values Mono 11.5px).
- **FAB** for New snapshot: 54px circle, `--accent`, `box-shadow: 0 10px 28px rgb(58 51 42 / 28%)`, plus icon 22px — same position as the existing New Invoice FAB (`right: 16px; bottom: 16px`), and it hides while a selection/other FAB is active, per existing FAB rules.

### 3. New snapshot form (`#18b`, third screen; desktop = modal)

**Purpose:** the weekly entry; the one flow the user repeats.

Desktop: modal `--radius-xl` 18px, `--bg-card`, `box-shadow --shadow-modal`, width ~680px, same chrome as the existing add-invoice modal.

- Header `padding: 16px 20px` + `1px #efe7d5`: title 14.5px/700 `New snapshot`; sub-line 11.5px `#8a7c62` → `Last snapshot 06.09.2026 · leave a field empty to carry the previous value forward`; date field right (`--bg-inset` `#f7f1e4`, `1px --border-color`, radius 10px, Mono 12.5px, calendar icon 12px), defaults to the next un-snapshotted week.
- Column header strip: `padding: 9px 20px`, background `#f9f4e8`, 10px/700/`.07em`/`#a3947a` → `POSITION` (flex) · `VALUE` (104px, right) · `DEPOSIT` (96px, right) · `DELTA` (84px, right).
- Depot label rows: 10.5px/700/`.08em`/`#8a7c62`.
- Position rows `padding: 6px 20px`: name 12.5px/600 with `· EUR` / `· USD` suffix in `#a3947a`; value input 104px and deposit input 96px (`padding: 8px 10px`, radius 9px, `--bg-inset`, `1px --border-color`, currency prefix 11px `#a3947a`, Mono 12.5px right-aligned); focused input gets `1.5px solid --accent` on `--bg-card`; delta cell 84px, Mono 12px/700, coloured, recomputed live as `value − previous_value − deposit`.
- A row left empty shows `carried` (11.5px `#a3947a`) in the delta cell instead of a number.
- Tab order runs row by row: value → deposit → next position. Inputs accept both `1.234,56` and `1234.56`.
- Footer `padding: 13px 20px`, background `#f9f4e8`, top border: left `Portfolio after save 17,146.76 €` (12px `#8a7c62`, amount Mono, bold, `#3a332a`, live), then `Cancel` (`--bg-card`, `1px --border-color`, radius 10px) and `Save snapshot` (`--accent`, radius 10px, 12.5px/600 `#fdf9f1`).
- Mobile: bottom sheet, radius `20px 20px 0 0`, grab handle 36×4px `#e2d8c2`, `max-height: 92%`, scrollable body, **sticky footer**; per position a stacked block — name 12px/600 then a row of value input / deposit input / delta (74px), inputs `padding: 11px 12px` (≥44px tall).
- Also needs an `+ Add position` affordance from this form (name, kind, currency, depot) — not drawn in the mock; use the existing add-invoice field styling.

### 4. Empty state + Settings (`#18c`)

- Empty state card: `--bg-card`, `1px --border-color`, radius 14px, `padding: 40px`, centred. Icon 32px stroke `--chart-1` `#c9a87c`. Title 16px/700 `No positions yet`. Body 12.5px `#8a7c62`, `max-width: 380px`, `line-height: 1.55` → `Add the positions you hold, then record one snapshot per week — value and deposit per position.` One primary button `Add first position`. **No import button** anywhere.
- `Settings → Portfolio` section (extend `templates/partials/modals/settings.html`): rows `padding: 13px 18px`, divider `#f3ede2`; each row title 12.5px/600 + 11px `#8a7c62` sub-line, control right:
  - **Depots** — `Trade Republic · Deka` → `Manage` button (`--bg-inset`, `1px --border-color`, radius 9px, 12px/600 `#6b5f4a`).
  - **Positions** — `9 active · 0 closed · type, currency, depot` → `Manage`.
  - **Benchmark** — `Index feed, weekly · fallback: MSCI World SRI` → select showing `MSCI World`.
  - **Snapshot reminder** — `Sunday evening, if no snapshot this week` → toggle (40×23px, `--accent` when on, 17px white knob).

## Interactions & behavior

- Nav: clicking Portfolio swaps the main view like the existing `data-view` switching in `static/js/`; the top-bar title on mobile becomes `Portfolio`. Portfolio has its own period state — switching back to Invoices must not inherit `3M/1Y/YTD/Max` and vice versa.
- Period change refetches `/api/portfolio`; the list itself always shows current values (period only affects the chart and the "Biggest changes" window when the period is shorter than a week — otherwise last snapshot vs the one before).
- Depot filter narrows list, totals, allocation and chart.
- Group header click collapses/expands the depot group; state persists per session.
- Position row click toggles the detail strip; several rows may be open; does not change row height above the row.
- Snapshot save: optimistic list update, then refetch; toast on success via the existing toast partial; on a duplicate date, replace after a confirm.
- Benchmark feed failure is silent (see above) — never blocks rendering.
- Keyboard: `N` opens New snapshot while the Portfolio view is active (mirrors `N` = New Invoice on the invoice view); `Esc` closes modal/sheet; document it in the shortcuts-help modal.
- Loading: reuse whatever skeleton/spinner treatment the invoice list uses. Empty period (positions exist, no snapshots in range): keep the cards, show the existing `.stats-empty` empty-state block inside the chart card.
- Responsive: summary grid collapses to 1-column under the app's existing mobile breakpoint; positions list becomes the two-line mobile row; charts keep their own heights (no fixed viewport units).

## State

`currentView`, `portfolioRange` (`3m|1y|ytd|max`, default `1y`), `depotFilter` (`all|<id>`), `collapsedDepots: Set<id>`, `expandedPositions: Set<id>`, snapshot-form draft (`date`, per-position `{value, deposit}`), `benchmarkSource`. Persist `portfolioRange` and `depotFilter` in `localStorage` under keys prefixed `summa.portfolio.` (do not touch existing keys).

## Design tokens (all already in `static/css/variables.css`)

Surfaces `--bg-primary #f3ede2`, `--bg-sidebar #ebe2d0`, `--bg-card #fdf9f1`, `--bg-inset #f7f1e4`, `--bg-hover #f9f4e8`, `--bg-selected #f0e6d2`; hero card `#e7dcc6` (existing total-card tone).
Lines `--border-color #e2d8c2`, `--border-strong #ddd2ba`, `--border-subtle #efe7d5`, row divider `#f3ede2`.
Text `--text-primary #3a332a`, `--text-secondary #6b5f4a`, `--text-muted #8a7c62`, `--text-faint #a3947a`.
Accents `--accent #c98d6b`, `--accent-text-on #fdf9f1`, accent text `#a5643c`, `--amount #7c6b3f`, gains `--success #54744a` / `--success-subtle #d7e4d2`, losses `#9c5b4a` / `#eed9d3`, badge `--cat-baecker #f0ddc8` / `#93683a`.
Charts `--chart-1 #c9a87c`, `--chart-2 #a8bfa0`, `--chart-3 #d9a48a`, `--chart-4 #b5a184`, `--chart-5 #c4b3d6`, `--chart-6 #d6bfa0`, `--chart-7 #a3c2c2`, `--chart-8 #e0cdb0`.
Radii 8 / 10 / 12–14 / 18px (`--radius-sm/md/lg/xl`). Shadows `--shadow-sm`, `--shadow-dropdown`, `--shadow-modal`. Transitions `--transition`.
Type: **Sora** for UI (self-hosted via `fonts.css`), **JetBrains Mono** for every date, amount and percentage. Sizes used: 9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14.5 / 15 / 16 / 24 / 25 / 30px.
New CSS belongs in a new `static/css/portfolio.css`, linked in `templates/index.html` after `stats.css`.

## Assets

Only `static/icons/icon-96.png` (already in the repo; used in the mock's sidebar/top bar). All other glyphs are inline SVG in the same Feather-like 24×24 / stroke-width-2 style as the existing partials — copy them from the design reference.

## Files in this bundle

- `design-reference.html` — the design canvas. Anchors: `#18a` desktop, `#18b` mobile, `#18c` empty state + settings; `#16a` sidebar grouping; `#14a` the row-expand pattern reused here. Needs `support.js` and `static/icons/icon-96.png` (both included) next to it.
- `support.js`, `static/icons/icon-96.png` — required by the reference file.
- `screenshots/18a-desktop.png`, `screenshots/18b-mobile.png`, `screenshots/18c-empty-and-settings.png`.

## Suggested order of work

1. Schema + migrations in `db.py`; `scripts/import_portfolio_xlsx.py`; import the real workbook and eyeball the numbers.
2. `GET /api/portfolio` with derived values; tests alongside `tests/test_stats_api.py`.
3. Sidebar grouping + view switching + empty state.
4. Positions list with groups, subtotals, expand.
5. Summary cards + Chart.js line/donut + biggest changes.
6. New snapshot modal → bottom sheet; keyboard shortcut; reminder.
7. Benchmark feed job + silent fallback.
