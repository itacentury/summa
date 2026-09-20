# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Summa is an invoice management and expense-tracking web app: a Flask REST backend
backed by SQLite, plus a vanilla-JS Progressive Web App frontend. There is no
build step for the frontend. The backend has a `pytest` suite under `tests/`.

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

Two operational CLIs live under `scripts/` and are not part of the served app:

```bash
uv run python -m scripts.import_portfolio_xlsx book.xlsx --fx USD=1.08  # load depot history
uv run python -m scripts.fetch_benchmark --symbol EUNL.DE --range 2y    # refresh the benchmark (cron)
```

Both take `--db` (default `$DATABASE_PATH`, else `invoices.db`), create the
portfolio schema when it is missing and are safe to re-run. `openpyxl` is a
**dev-only** dependency, so the runtime image never carries it — the importer is a
workstation tool. `scripts` is in `[tool.mypy] files`, so both are strict-checked.

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
npm run format     # prettier --write across the repo
```

ESLint config (`eslint.config.js`) lints `static/js/app.js` (browser script) and
`static/sw.js` (service worker), and runs `@html-eslint` over `templates/*.html`
for semantic/a11y checks (its formatting rules are off — Prettier owns
formatting, via `prettier-plugin-jinja-template` for the Jinja template).
Stylelint (`.stylelintrc.json`) enforces the `docs/code-style.md` CSS rules
(recess-order property order, no `!important`, no id selectors, value hygiene).
Functions called only from inline HTML handlers are listed in a top-of-file
`/* exported … */` directive in `app.js` so `no-unused-vars` does not flag them.

CI (`.github/workflows/ci.yml`) has three jobs that must pass: `lint` (`ruff
check .`, `ruff format --check .`, `mypy`), `test` (`pytest`) and `frontend`
(`npm run lint`). Run them before pushing.

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
`portfolio.py` → `/api/portfolio*`); the DB layer lives in `summa/db.py`
and shared types/helpers in `summa/helpers.py`. Key conventions:

- **SQLite:** `invoices` and `invoice_items` (FK with `ON DELETE CASCADE`), plus
  the four portfolio tables `portfolio_depots`, `portfolio_positions`,
  `portfolio_snapshots` and `benchmark_prices`, created by
  `create_portfolio_schema()`. Connections come from `get_db()` (`summa/db.py`), which
  sets `row_factory` and enables WAL mode. `DATABASE_PATH` env var overrides the
  default `invoices.db`.
- **Schema + migrations live in `init_db()`** (`summa/db.py`), which runs inside
  `create_app()` (so it works under both gunicorn and the dev server). Migrations
  are done inline by
  inspecting `PRAGMA table_info` and conditionally `ALTER TABLE`-ing new columns
  (e.g. `deleted_at`, `category`). Add future column migrations the same way.
- **Soft deletes:** rows are never physically deleted. Delete endpoints set
  `deleted_at = CURRENT_TIMESTAMP`, and every read query filters
  `WHERE deleted_at IS NULL`. Preserve this filter in any new query.
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
  `Response | tuple[Response, int]` (the `ApiResponse` alias) and wrap writes in
  try/commit/except-rollback/finally-close. `strip_text()` normalizes input
  (empty string -> `None`). CORS is enabled globally for native mobile clients.

**Portfolio — a second area on the same database.** Depots hold positions, a
position holds weekly snapshots, and a snapshot stores only raw facts: a value, a
signed deposit and an FX rate, all in the position's own currency (`fx_rate` =
units of that currency per EUR, so `value_eur = value / fx_rate`). Everything
shown — EUR sums, invested, gains, the weekly delta, the chart series, allocation
and the biggest movers — is derived on read by the **pure** module
`summa/portfolio.py` (no Flask, no SQL), which is why `tests/test_portfolio.py`
can prove the rules without HTTP; `summa/routes/portfolio.py` only queries and
calls into it. Two invariants: **a sale is recorded, not flagged** (`closed_at`
plus a closing row derived by `with_sale_recorded()`, never stored), and
`carried = 1` marks a value copied forward from the previous week rather than
entered. History is loaded by `scripts/import_portfolio_xlsx.py`, which reads the
wide workbook (row 1 depot bands, row 2 a `name · Einzahlung · Delta` triple per
position, row 3+ one row per week), recomputes Delta instead of importing it, and
is idempotent via `INSERT OR IGNORE` on `(position_id, date)` — a re-run never
rewrites a week you corrected in the UI. `scripts/fetch_benchmark.py` keeps
`benchmark_prices` fresh from a public chart feed and exits non-zero so cron can
report; the API falls back to the `is_benchmark_fallback` position when the feed
has nothing for the window, so a failed run costs only the chart footnote.

**Frontend — `static/js/app.js` + `templates/index.html`.** Plain JS (no
framework, no bundler) talking to the API. `app.js` boots behind the login gate:
`getAuthStatus()` (`static/js/auth.js`) decides whether `init()` runs or the
login view is rendered first, so nothing touches the API before the session is
known. **Every API call goes through `apiFetch()` in `static/js/http.js`** — it
latches the first 401 and re-raises the gate, so a new call site must use it
rather than bare `fetch` — except the auth endpoints themselves, whose 401s are
answers, not expiries: `auth.js` calls `/api/auth/*` with bare `fetch` on
purpose, because latching a wrong password would re-enter the login view
mid-submit and then swallow every genuine expiry. Styling is split per
component under `static/css/` (`variables`, `base`, `header`, `filters`,
`invoices`, `modals`, `components`, `stats`, `portfolio`), loaded via ordered `<link>` tags
in `index.html` — the order is cascade-significant, and each file co-locates
its own responsive `@media` rules.

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
`/data/invoices.db`.

Image build, vulnerability scan and push live in a separate
[`docker` workflow](.github/workflows/docker.yml) (distinct from CI's three
jobs): it builds both `linux/amd64` and `linux/arm64`, scans the image once with
`grype` and gates the push on _fixable_ critical CVEs (a `jq` step reads the
scan's JSON `fix.state`), uploads the full scan SARIF to the Security tab and
attaches an SPDX SBOM to the pushed image.
