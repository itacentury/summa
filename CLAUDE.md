# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Summa is an invoice management and expense-tracking web app: a Flask REST backend
backed by SQLite, plus a vanilla-JS Progressive Web App frontend. There is no
build step for the frontend. The backend has a `pytest` suite under `tests/`, the
frontend a Vitest suite under `tests/frontend/`.

## Code Style

See @docs/code-style.md for code style and convention rules (applies on every machine).

## Commands

Tooling is driven through `uv` (Python 3.12+):

```bash
uv sync                                 # install deps + create .venv
uv run --env-file .env python -m summa  # run dev server (port 8000, DB at ./invoices.db)
uv run ruff format .                    # format
uv run ruff check .                     # lint (E, F, I; E501 intentionally ignored)
uv run mypy                             # strict type check (files set in pyproject.toml)
uv run pytest                           # backend test suite (tests/)
```

Three operational CLIs live under `scripts/` and are not part of the served app:

```bash
uv run python -m scripts.import_portfolio_xlsx book.xlsx --fx USD=1.08  # load depot history
uv run python -m scripts.fetch_benchmark --symbol EUNL.DE --range 2y    # refresh the benchmark (compose loop)
uv run python -m scripts.seed_portfolio --reset                         # fake depot history for UI checks
```

All three take `--db` (default `$DATABASE_PATH`, else `invoices.db`), create the
portfolio schema when it is missing and are safe to re-run. All three also take
`--dry-run`, which writes nothing at all: the importer and the seeder run against
an in-memory copy of the database (`connect_mirror()` in
`scripts/portfolio_db.py`), so a dry run neither creates the file nor touches an
existing one. `openpyxl` is a **dev-only** dependency, so the runtime image never
carries it — the importer is a workstation tool. `fetch_benchmark` is the
exception: `.dockerignore` whitelists it (plus `__init__.py` and
`portfolio_db.py`) into the image, where the `benchmark` compose service runs it
in a sleep loop (`BENCHMARK_INTERVAL_SECONDS`, default daily), so keep its
imports to the stdlib and `summa` — the `docker` workflow's smoke step
(`python -m scripts.fetch_benchmark --help` in the built image) fails on any
other import. `scripts` is in
`[tool.mypy] files`, so all three are strict-checked.

`seed_portfolio.py` is a workstation tool too, for looking at the Portfolio
screen against something: it generates three depots and eleven positions (one
of them sold, two in a foreign currency) over `--weeks` of weekly snapshots plus
a matching benchmark series, so the depot switcher, allocation pooling, both
mover lists and all four range filters have data. Generation is pure and keyed
on `--seed`, so a screenshot is reproducible; `--reset` clears the four
portfolio tables first and never touches the invoice side, while a re-run
without it keeps every week already recorded.

`docs/screenshots/` is a **generated** artifact of the UI, produced in full by
`scripts/screenshots.mjs` (a fourth workstation tool; it seeds both sides of the
database, drives Playwright and replaces every PNG at once). Never add or edit a
screenshot by hand. **When a change alters a captured surface, regenerate the set
once before the branch is merged** — once per branch, not per commit, because
each run is a binary diff over the whole folder. A surface worth showing that no
existing shot covers means three edits together: a step in `screenshots.mjs`, a
row in the index in `docs/screenshots/README.md`, and a cell in the root
`README.md` table if it belongs in the shop window. Playwright and Sharp live
outside the root frontend toolchain in the separately locked
`scripts/screenshots/` package; `docs/screenshots/README.md` documents its setup
and the run.

`.env` — copied from `.env.example` — is what decides whether a local run is behind
the login gate (`AUTH_ENABLED`), and `uv` fails outright when that file is missing. The
VS Code task `Run: Start Server` (`summa.code-workspace`) loads it the same way, through
`uv run --env-file .env flask --app summa.wsgi run`. An invocation _without_
`--env-file` ignores `.env` completely and therefore runs ungated — which is what the
`verify` skill relies on.

Frontend (JS/CSS/HTML) is linted and formatted through `npm` (Node 22):

```bash
npm install        # install the lint/format toolchain
npm run lint       # eslint + stylelint + prettier --check (what CI runs)
npm run test       # Vitest suite under tests/frontend/ (happy-dom)
npm run format     # prettier --write across the repo
```

ESLint config (`eslint.config.js`) lints the browser modules under
`static/js/` (`boot-view.js` as the one classic script), `static/sw.js`
(service worker), the two config files, the Node tooling under `scripts/` and
the Vitest suite under `tests/frontend/`, and runs `@html-eslint` over
`templates/**/*.html` for semantic/a11y checks (its formatting rules are off —
Prettier owns formatting, via `prettier-plugin-jinja-template` for the Jinja
templates).
Stylelint (`.stylelintrc.json`) enforces the `docs/code-style.md` CSS rules
(recess-order property order, no `!important`, no id selectors, value hygiene).
There are no inline event handlers: everything is wired with
`addEventListener`, mostly against `data-action` hooks.

CI (`.github/workflows/ci.yml`) has three jobs that must pass: `lint` (`ruff
check .`, `ruff format --check .`, `mypy`), `test` (`pytest`) and `frontend`
(`npm run lint`, `npm run test`). Run them before pushing.

Docker: `docker compose up -d` serves on `http://localhost:8000` with the DB
persisted in the `./data` bind mount.

## Architecture

**Backend — `summa/` package (app factory).** `create_app()` in
`summa/__init__.py` builds the Flask app, enables CORS, registers the blueprints
and calls `init_db()`. Importing the `summa` package itself has no side effects;
the eager WSGI/CLI instance `app = create_app()` lives in `summa/wsgi.py`
(`FLASK_APP=summa.wsgi`, gunicorn `summa.wsgi:app`). Routes are split into blueprints under
`summa/routes/` (`web.py` → `/`, `auth.py` → `/api/auth/*`, `invoices.py` →
`/api/invoices*` + `/stores` + `/categories`, `stats.py` → `/api/stats`,
`portfolio.py` → `GET /api/portfolio*`, `portfolio_writes.py` → the portfolio
POST/PATCH routes); the DB layer lives in `summa/db.py`
and shared types/helpers in `summa/helpers.py`. Key conventions:

- **SQLite:** `invoices` and `invoice_items` (FK with `ON DELETE CASCADE`), plus
  the four portfolio tables `portfolio_depots`, `portfolio_positions`,
  `portfolio_snapshots` and `benchmark_prices`, created by
  `create_portfolio_schema()`. Connections come from `get_db()` (`summa/db.py`), which
  sets `row_factory` and enables WAL mode. `DATABASE_PATH` env var overrides the
  default `invoices.db`; it is read per connection by `config.database_path()`,
  which the scripts' `--db` default shares, so a test redirects every connection
  with `monkeypatch.setenv`.
- **Schema + migrations live in `init_db()`** (`summa/db.py`), which runs inside
  `create_app()` (so it works under both gunicorn and the dev server). A column
  added to `invoices` later is one row in `_INVOICE_COLUMN_MIGRATIONS` — its name
  and the `ALTER TABLE` that adds it (e.g. `deleted_at`, `category`) — which
  `_migrate_invoice_columns()` runs only when `PRAGMA table_info` still lacks the
  column. `init_db()` runs the whole schema setup in one `BEGIN IMMEDIATE`
  transaction, because gunicorn's workers (no `--preload`) each call it at the
  same time: the write lock is the duplicate-column guard, letting the second
  worker see the finished migration, so a new row needs no guard of its own.
- **Soft deletes (invoice side only):** invoice rows are never physically deleted.
  Delete endpoints set `deleted_at = CURRENT_TIMESTAMP`, and every read query on
  `invoices` filters `WHERE deleted_at IS NULL` — preserve this filter in any new
  invoice query. The column lives on `invoices` alone; its child rows
  (`invoice_items`, `invoice_category_suggestions`) are excluded by joining against
  it. The portfolio tables have no `deleted_at` at all: a sold position is recorded
  through `closed_at` (see _Portfolio_ below), so portfolio queries have no such
  filter.
- **Optional password gate** (`summa/config.py`, `summa/auth.py`,
  `summa/ratelimit.py`): off unless `AUTH_ENABLED` is set. A single
  `before_request` hook in `create_app()` denies by default; `is_public()` in
  `summa/auth.py` holds the allowlist. The invariant to preserve when adding
  routes: **everything needed to render the login screen is public, everything
  that returns data is not** — so `/` and `/static/` stay open, and a new API
  route is protected the moment it exists. The one exemption is a CORS preflight
  (`is_preflight()`): it arrives without cookies and returns no data, so gating it
  would only stop the browser from ever sending the real request. The session rides on Flask's own
  signed cookie (configured in `_configure_sessions()`), and every config value
  is read inside its accessor, never at import, so tests can toggle the gate
  with `monkeypatch.setenv`. What `create_app()` snapshots at boot (the cookie
  attributes, `PERMANENT_SESSION_LIFETIME`, the CORS allowlist) is frozen for the
  process, so a test changing one of those must build the client with the value
  (the `build_client` fixture) rather than setting the env afterwards — and code
  serving such a value to clients should read it back from `app.config`, not from
  the environment, so the two can never disagree.
- **REST API under `/api/`** (invoices CRUD, `/import`, `/bulk-update`,
  `/bulk-delete`, `/stores`, `/categories`, `/stats`). Handlers return
  `Response | tuple[Response, int]` (the `ApiResponse` alias) and run their
  queries inside `with db_cursor()`, which commits on success and rolls back on
  any exception. A `sqlite3.Error` is left to propagate: the one app-wide
  handler in `create_app()` logs it and answers with a generic 500, so the error
  text (table and column names) never reaches a client. Catch it in a route only
  to turn a specific failure into its own answer (an `IntegrityError` into a
  409). Non-JSON (415) and malformed (400) bodies get the same JSON error shape
  from their own app-wide handlers. `strip_text()` normalizes input
  (empty string -> `None`). CORS is enabled globally for native mobile clients.

**Portfolio — a second area on the same database.** Depots hold positions, a
position holds weekly snapshots, and a snapshot stores only raw facts: a value, a
signed deposit and an FX rate, all in the position's own currency (`fx_rate` =
units of that currency per EUR, so `value_eur = value / fx_rate`). Everything
shown — EUR sums, invested, gains, the weekly delta, the chart series, allocation
and the biggest movers — is derived on read by the **pure** module
`summa/portfolio.py` (no Flask, no SQL), which is why `tests/test_portfolio.py`
can prove the rules without HTTP; `summa/routes/portfolio.py` (reads) and
`summa/routes/portfolio_writes.py` (writes) only query and call into it. Two invariants: **a sale is recorded, not flagged** (`closed_at`
plus a closing row derived by `with_sale_recorded()`, never stored), and
`carried = 1` marks a value copied forward from the previous week rather than
entered. History is loaded by `scripts/import_portfolio_xlsx.py`, which reads the
wide workbook (row 1 depot bands, row 2 a `name · Einzahlung · Delta` triple per
position, row 3+ one row per week), recomputes Delta instead of importing it, and
is idempotent via `INSERT OR IGNORE` on `(position_id, date)` — a re-run never
rewrites a week you corrected in the UI. `scripts/fetch_benchmark.py` keeps
`benchmark_prices` fresh from a public chart feed and exits non-zero so the
`benchmark` compose loop retries after an hour (the error lands in `docker
compose logs benchmark`). Which symbol the chart draws is configuration, not freshness:
`config.benchmark_symbol()` (`BENCHMARK_SYMBOL`, default `EUNL.DE`) names it for
both the job's `--symbol` default and `_feed_points()`, so an exploratory fetch
of another ticker writes rows nothing reads. Only when the configured symbol has
no rows at all does the freshest symbol on record stand in, and when neither
yields points inside the window the API falls back to the
`is_benchmark_fallback` position — so a failed run costs only the chart footnote.

**Frontend — `static/js/app.js` + `templates/index.html`.** Plain JS (no
framework, no bundler) talking to the API. `app.js` boots behind the login gate:
`getAuthStatus()` (`static/js/auth.js`) decides whether `init()` runs or the
login view is rendered first, so nothing touches the API before the session is
known. **Every API call goes through `apiFetch()` in `static/js/http.js`** — it
latches the first 401 and re-raises the gate, so a new call site must use it
rather than bare `fetch` — except the auth endpoints themselves, whose 401s are
answers, not expiries: `auth.js` calls `/api/auth/*` with bare `fetch` on
purpose, because latching a wrong password would re-enter the login view
mid-submit and then swallow every genuine expiry. **Which of the three views is
shown is driven by the URL hash** (`/#portfolio`), so a reload stays where the
user was and back/forward step between views: `static/js/views.js` switches only
on `hashchange` plus one `applyViewFromHash()` at the end of `init()` (last,
because entering a view loads its data), and a nav click merely assigns
`location.hash`. `setView()` therefore must never write to the URL — that would
re-enter the router through its own event. Because `init()` only runs once the
auth check has answered, that switch would land well after the first paint, so
`static/js/boot-view.js` — a blocking classic script, the only non-module under
`static/js/` — applies the same shell state while the page is still parsing.
**It is the first thing in `<body>` for a reason:** a parser-blocking script
only holds back what follows it, so from any later position the browser may
already have painted the invoices view. That position costs it the DOM, hence
two phases — the view-mode class goes on `document.body` immediately (which is
what the `body.stats-mode .invoices-section` rule in `invoices.css` turns into a
hidden section), and the view roots, topbar title and nav item follow on
`readystatechange`, i.e. as soon as parsing ends and still long before the auth
check answers. It deliberately loads no data, and beyond the mode class it
copies no view table: it reads the tokens and titles off the nav items, so
`views.js` stays the single authority. Styling is split per
component, one file each under `static/css/`, loaded via ordered `<link>` tags
in `index.html` — that order is authoritative and cascade-significant, and each
file co-locates its own responsive `@media` rules.

**PWA.** `static/sw.js` caches static assets under the `CACHE_NAME` constant.
**When you change any cached static asset, bump `CACHE_NAME`** (in
`static/sw.js`) or clients keep serving the stale cached version. The service
worker is registered from `app.js`. JS modules under `static/js/` and CSS files
under `static/css/` are auto-discovered at install time via the
`/static/js-manifest.json` and `/static/css-manifest.json` routes
(`summa/routes/web.py`, which glob `static/js/*.js` and `static/css/*.css`), so
adding a module or stylesheet needs no `sw.js` edit — only a `CACHE_NAME` bump
when an existing cached asset's content changes.

## Deployment

Multi-stage `Dockerfile` (both stages from `python:3.12-slim`): a `builder` stage
installs runtime-only dependencies via `uv sync --frozen --no-dev
--no-install-project` (uv pinned by copying it from `ghcr.io/astral-sh/uv`); the
final stage copies just the built virtualenv (`COPY --from=builder /app/.venv`)
and the app together with the pre-generated PWA icons committed under
`static/icons/` (no build-time icon generation). Runs `gunicorn` (2 workers,
4 threads) as a non-root `appuser`. `entrypoint.sh` fixes `/data` volume
ownership via `setpriv` before dropping privileges. In the container the DB lives at
`/data/invoices.db`. `docker-compose.yml` runs a second service, `benchmark`, from
an image built from the same Dockerfile to refresh `benchmark_prices` (see _Commands_).

Image build, vulnerability scan and push live in a separate
[`docker` workflow](.github/workflows/docker.yml) (distinct from CI's three
jobs): it builds both `linux/amd64` and `linux/arm64`, scans the image once with
`grype` and gates the push on _fixable_ critical CVEs (a `jq` step reads the
scan's JSON `fix.state`), uploads the full scan SARIF to the Security tab and
attaches an SPDX SBOM to the pushed image.
