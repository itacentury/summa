# Invoice feature: refactoring findings

A review of the invoice side of Summa (backend routes and helpers, frontend
modules, templates, CSS and tests), looking for code that can be simplified,
shrunk, refactored or made easier to read. Portfolio, auth and `scripts/` are
out of scope.

Every finding below was checked against the code at the time of writing. Line
numbers refer to that state and will drift as the code changes. Candidates that
did not hold up are listed under [Rejected](#rejected-checked-and-fine) so they
are not re-raised.

**Effort:** S = under an hour, M = a few hours, L = a day or more.
**Risk:** how likely the change is to break behaviour that tests do not pin.

## Summary

| ID  | Finding                                                          | Priority | Effort | Risk |
| --- | ---------------------------------------------------------------- | -------- | ------ | ---- |
| B1  | `bulk-delete` re-deletes already deleted invoices                | Bug      | S      | Low  |
| B2  | Categories from create/edit/import skip `clean_category()`       | Bug      | S      | Low  |
| B3  | `categorize-suggest` returns the raw SQLite error on a 500       | Security | S      | Low  |
| B4  | Non-JSON request bodies get an HTML 415 instead of a JSON error  | Bug      | S      | Low  |
| B5  | Bulk routes log the full id list                                 | Ops      | S      | Low  |
| B6  | Add-invoice / bulk-edit / filter labels are not tied to inputs   | A11y     | S      | Low  |
| R1  | Six copies of the `sqlite3.Error` → log → 500 block              | Refactor | M      | Low  |
| R2  | `categorize_suggest()` is ~190 lines with five jobs              | Refactor | M      | Med  |
| R3  | Duplicated SQL and row serialization in `invoices.py`            | Refactor | S      | Low  |
| R4  | `_build_invoice_filter()` and the stats filter repeat each other | Refactor | S      | Low  |
| R5  | Four copies of the deferred-commit closure in the frontend       | Refactor | M      | Med  |
| R6  | `combobox.js` reimplements `createFloatingMenu()`                | Refactor | M      | Med  |
| R7  | Item-row markup exists twice (template and JS)                   | Refactor | S      | Low  |
| R8  | `init_db()` manages its connection by hand                       | Refactor | S      | Low  |
| C1  | Literal hex colors that equal existing design tokens             | Cleanup  | S      | Low  |
| C2  | Legacy token shim is half dead                                   | Cleanup  | S      | Low  |
| C3  | Two different close-icon SVGs, five inline copies                | Cleanup  | S      | Low  |
| C4  | `state.js` mixes invoice, portfolio and chart state              | Cleanup  | M      | Med  |
| C5  | `chartColors` duplicates `--chart-1…8`                           | Cleanup  | S      | Low  |
| C6  | Pluralization and small repetitions                              | Cleanup  | S      | Low  |
| C7  | Minor backend readability points                                 | Cleanup  | S      | Low  |
| C8  | Test helper duplication                                          | Cleanup  | S      | Low  |
| D1  | `CLAUDE.md` describes an `/* exported */` directive that is gone | Docs     | S      | None |
| D2  | `CLAUDE.md` ESLint scope is out of date                          | Docs     | S      | None |
| D3  | `CLAUDE.md` CSS file list is out of date                         | Docs     | S      | None |
| D4  | `CLAUDE.md` CI and test descriptions omit the Vitest suite       | Docs     | S      | None |

## Bugs and security

### B1 — `bulk-delete` re-deletes already deleted invoices

[summa/routes/invoices.py L703-L710](../summa/routes/invoices.py#L703-L710)

`bulk_delete_invoices()` runs
`UPDATE invoices SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (…)` without
`AND deleted_at IS NULL`. The other write paths all have that guard:
`delete_invoice()`, `update_invoice()` and `bulk_update_invoices()`. So sending
ids that are already deleted:

- overwrites their original `deleted_at` timestamp, and
- counts them in the `deleted` number of the response.

**Suggestion:** add `AND deleted_at IS NULL` to the statement, and add a test
that bulk-deletes an already deleted id and expects `deleted == 0` with an
unchanged timestamp.

### B2 — Categories from create/edit/import skip `clean_category()`

[summa/helpers.py L173-L175](../summa/helpers.py#L173-L175) ·
[summa/routes/invoices.py L664-L668](../summa/routes/invoices.py#L664-L668)

`parse_invoice()` normalizes `category` with `strip_text()`. That trims the ends
but does not collapse inner whitespace or newlines, and it does not cap the
length. `bulk_update_invoices()` uses `clean_category()`, which does all three,
and its comment says so "no client can persist an oversized category". But
`POST /api/invoices`, `PUT /api/invoices/<id>` and `/import` all go through
`parse_invoice()`. On those paths a 10 kB category, or `"Food\n\nStuff"`, is
stored as-is.

**Suggestion:** use `clean_category()` in `parse_invoice()`. That gives every
write path one rule and makes the bulk-update comment true.

### B3 — `categorize-suggest` returns the raw SQLite error on a 500

[summa/routes/invoices.py L409-L411](../summa/routes/invoices.py#L409-L411) ·
[summa/helpers.py L42-L45](../summa/helpers.py#L42-L45)

Every other route answers a database failure with a generic
`"Internal server error"`. `categorize_suggest()` answers with `str(e)`, which
leaks SQL error text such as table and column names to the client.
`ValidationError` even has a comment explaining that `str(exception)` must not
reach a response (CodeQL `py/stack-trace-exposure`).

**Suggestion:** return `"Internal server error"` here as well. The 502 branch at
[L444-L446](../summa/routes/invoices.py#L444-L446) returns
`str(AiCategorizationError)`. That is fine only if those messages are known to
be written for users; check `summa/ai.py` and pass them through `.message` in
the same way `ValidationError` does.

### B4 — Non-JSON request bodies get an HTML 415 instead of a JSON error

[summa/routes/invoices.py L488](../summa/routes/invoices.py#L488) (and L521,
L577, L641, L695)

The write routes read `request.json`. Current Flask raises
`UnsupportedMediaType` when the `Content-Type` is not JSON. The only JSON
`errorhandler` the app registers is for `RequestEntityTooLarge`
([summa/\_\_init\_\_.py L137](../summa/__init__.py#L137)), so such a request
gets Werkzeug's HTML 415 page instead of the `{success: false, error}` shape.
That breaks native clients that parse every error body as JSON.

**Suggestion:** either use `request.get_json(silent=True)` (the parsers already
reject `None` with a proper 400) or register a JSON handler for
`UnsupportedMediaType` and `BadRequest` next to the existing one. The second
option also covers the portfolio routes.

### B5 — Bulk routes log the full id list

[summa/routes/invoices.py L681-L688](../summa/routes/invoices.py#L681-L688) ·
[L712-L719](../summa/routes/invoices.py#L712-L719)

`ids=%s` interpolates the whole list. With `page_size=all` plus "select all"
that can be thousands of ids per log line, on both success and failure.

**Suggestion:** log the count, plus the first few ids if they help with
debugging.

### B6 — Add-invoice / bulk-edit / filter labels are not tied to inputs

[templates/partials/modals/add-invoice.html L19](../templates/partials/modals/add-invoice.html#L19)
(also L38, L49, L78, L86) ·
[bulk-edit.html L19](../templates/partials/modals/bulk-edit.html#L19) (also L29) ·
[filters.html L231-L258](../templates/partials/filters.html#L231-L258) ·
[import.html L49](../templates/partials/modals/import.html#L49) ·
[static/js/modals.js L25-L44](../static/js/modals.js#L25-L44)

The `<label class="form-label">` elements have no `for` and do not wrap their
control. Screen readers therefore announce the inputs without a name, and
clicking a label does not focus its field. The icon-only "remove item" button,
both in the template and in `itemRowInnerHtml()`, has no `aria-label`.

**Suggestion:** give each input an `id` and each label a `for`. The dynamic item
rows need generated ids, or can use `aria-label` instead. Add
`aria-label="Remove item"` to the remove button. `@html-eslint` may have a rule
that catches unassociated labels; worth turning on.

## Simplification and refactoring

### R1 — Six copies of the `sqlite3.Error` → log → 500 block

[summa/routes/invoices.py L510-L512](../summa/routes/invoices.py#L510-L512),
[L569-L571](../summa/routes/invoices.py#L569-L571),
[L613-L615](../summa/routes/invoices.py#L613-L615),
[L633-L635](../summa/routes/invoices.py#L633-L635),
[L687-L689](../summa/routes/invoices.py#L687-L689),
[L718-L720](../summa/routes/invoices.py#L718-L720)

`add_invoice`, `import_invoices`, `update_invoice`, `delete_invoice`,
`bulk_update_invoices` and `bulk_delete_invoices` all wrap their body in the
same `try: … except sqlite3.Error as e: logger.error(…); return
error_response("Internal server error", 500)`. That puts the success path one
level deeper than it needs to be.

**Suggestion:** register one `@invoices_bp.errorhandler(sqlite3.Error)` (or an
app-wide one) that logs with `logger.exception` and returns the generic 500.
The routes then drop their `try`, and the success path moves back to the left.
The context in each log message (such as the invoice id) is still available
from `request.path`. This also fixes B3 by construction.
`_cache_suggestions()` keeps its own `try`, because swallowing that error is
intentional there.

### R2 — `categorize_suggest()` is ~190 lines with five jobs

[summa/routes/invoices.py L295-L482](../summa/routes/invoices.py#L295-L482)

One function currently:

1. parses the request,
2. collects candidates chunk by chunk,
3. loads the items,
4. loads the cache and splits cached hits from misses,
5. calls the model and merges the result into the response.

The `with db_cursor()` block alone is about 80 lines with two levels of
conditional nesting.

**Suggestion:** extract pure or cursor-taking helpers, and keep the route as
roughly 30 lines of orchestration:

- `_load_candidates(cursor, ids) -> tuple[int, list[Row]]` (chunked
  count + lowest ids)
- `_load_items(cursor, ids) -> dict[int, list[dict]]`
- `_load_cached(cursor, ids) -> dict[int, Row]`
- `_partition_by_cache(invoices, cache, fingerprints, model) -> (resolved, misses)`
- `_build_suggestions(invoices, resolved, existing_lower) -> list[dict]`

`_partition_by_cache` and `_build_suggestions` are pure, so they can be tested
directly without HTTP. The three separate empty-result
`jsonify({"suggestions": [], "count": 0, "total": 0})` returns
([L319](../summa/routes/invoices.py#L319), [L322](../summa/routes/invoices.py#L322),
[L414](../summa/routes/invoices.py#L414)) can share one constant or helper.

### R3 — Duplicated SQL and row serialization in `invoices.py`

- **Existing categories:** the same `SELECT DISTINCT category … ORDER BY
category` appears in `get_categories()`
  [L248-L251](../summa/routes/invoices.py#L248-L251) and in
  `categorize_suggest()` [L390-L393](../summa/routes/invoices.py#L390-L393).
  Suggestion: `_existing_categories(cursor) -> list[str]`.
- **Invoice insert:** `INSERT INTO invoices (date, store, category, total)` followed by
  `insert_invoice_items()` appears in `add_invoice()`
  [L496-L501](../summa/routes/invoices.py#L496-L501) and in `import_invoices()`
  [L546-L550](../summa/routes/invoices.py#L546-L550). Suggestion:
  `insert_invoice(cursor, invoice) -> int` in `summa/db.py`, next to
  `insert_invoice_items()`.
- **Row serialization:** `get_invoices()` [L158-L167](../summa/routes/invoices.py#L158-L167) and
  `get_invoice()` [L221-L230](../summa/routes/invoices.py#L221-L230) both build
  `{id, date, store, category, total}` from a row. Suggestion:
  `_invoice_summary(row) -> dict`, which the detail route extends with `items`.
- **Sort columns:** the allowed sort columns `["date", "store", "total"]` are an
  inline list in [L108](../summa/routes/invoices.py#L108). Make it a module
  constant `SORT_COLUMNS: Final[frozenset[str]]` next to `DEFAULT_PAGE_SIZE`,
  because it is the only thing standing between user input and an f-string in
  `ORDER BY`.
- **SET clause:** `bulk_update_invoices()` rebuilds `", ".join(set_clauses)` inside the
  chunk loop [L672-L678](../summa/routes/invoices.py#L672-L678). Build it once
  before the loop.

### R4 — `_build_invoice_filter()` and the stats filter repeat each other

[summa/routes/invoices.py L53-L91](../summa/routes/invoices.py#L53-L91) ·
[summa/routes/stats.py L67-L74](../summa/routes/stats.py#L67-L74)

`_build_invoice_filter()` has four identical "if arg: append clause and param"
blocks. `get_stats()` rebuilds the `date_from`/`date_to` part by hand, with its
own base condition.

**Suggestion:** turn the four equality and range filters into a small table
such as `(("store", "store = ?"), ("category", "category = ?"), ("date_from",
"date >= ?"), ("date_to", "date <= ?"))` with one loop. Keep the `search` clause
special. Then `get_stats()` can call `_build_invoice_filter()`, after moving it
somewhere both blueprints can import, such as `summa/helpers.py` or a
`summa/queries.py`. Because it only forwards the date args, the result is the
same as today. As a bonus, the stats view would be one argument away from
supporting the store/category filters.

### R5 — Four copies of the deferred-commit closure in the frontend

[static/js/invoices.js L136-L165](../static/js/invoices.js#L136-L165) ·
[L203-L232](../static/js/invoices.js#L203-L232) ·
[static/js/bulk.js L197-L231](../static/js/bulk.js#L197-L231) ·
[L302-L332](../static/js/bulk.js#L302-L332) (plus the categorize apply at
[static/js/categorize.js L577](../static/js/categorize.js#L577))

`deferInvoiceUpdate`, `deleteInvoice`, `saveBulkEdit` and `bulkDeleteInvoices`
each define the same `commit` closure:

1. send with `keepalive: true`,
2. on failure show an error toast and revert,
3. on success run the follow-up and, if nothing newer is pending
   (`hasPendingToast()`), `reloadCurrentPage()`,
4. `catch` shows the same error toast and reverts.

The three-line "why keepalive" and "why skip the reconcile" comments are also
copied into each one. The copies have drifted: the single-invoice paths check
`response.ok`, while the bulk paths parse the body and check `result.success`.

**Suggestion:** add one helper, e.g.
`deferCommit(label, { send, onUndo, onSuccess, errorText })`, in `toast.js` or a
small `deferred.js`. It owns the keepalive request, the success check (use one
rule, preferably `response.ok`), the revert on failure and the guarded reload.
Each caller keeps only its optimistic state change and its `onSuccess` (such as
the lookup refresh). The comments then exist once. This is medium risk because
the commit-on-unload and undo timing are subtle. The existing Vitest suites
cover the paths, so run them.

### R6 — `combobox.js` reimplements `createFloatingMenu()`

[static/js/combobox.js L175-L231](../static/js/combobox.js#L175-L231) ·
[static/js/floating-menu.js L43](../static/js/floating-menu.js#L43)

`floating-menu.js` exists to own fixed-position anchoring, including flipping
upwards, viewport clamping and scroll/resize tracking. `ai-model.js` and
`pagesize.js` already use it. `combobox.js` still carries its own
`positionMenu()`, `clearMenuPosition()` and `syncScrollTracking()`, with slightly
different constants:

- a 120 px minimum versus 80 px,
- a 4 px gap versus 6 px,
- no horizontal clamping.

So the same control class behaves differently at a viewport edge depending on
the widget.

**Suggestion:** build the floating combobox on
`createFloatingMenu(control, menu, { matchTrigger: true, maxHeight: 240, gap: 4 })`
and keep only its breakpoint switch (`shouldFloatMenu()`) and the resize-settle
logic. This is medium risk: the combobox's upward-opening rule was tuned for the
mobile bottom sheet, so check that case (a combobox inside an open modal on a
small viewport) after the switch.

### R7 — Item-row markup exists twice

[templates/partials/modals/add-invoice.html L75-L112](../templates/partials/modals/add-invoice.html#L75-L112) ·
[static/js/modals.js L25-L44](../static/js/modals.js#L25-L44)

The add/edit dialog ships one hand-written empty item row in the template.
`itemRowInnerHtml()` produces the same row in JS, and every open or reset of the
dialog renders the container from JS anyway.

**Suggestion:** leave `data-el="items-container"` empty in the template and let
JS be the only source. That also fixes B6 for the item rows in one place.

### R8 — `init_db()` manages its connection by hand

[summa/db.py L147-L257](../summa/db.py#L147-L257)

`init_db()` opens `get_db()` and ends with `conn.commit(); conn.close()`, with no
`try/finally`. If a migration raises, the connection is neither rolled back nor
closed, although `db_cursor()` exists for exactly this.

The two column migrations also check `PRAGMA table_info` and then still catch
`OperationalError` "already exists"
([L198-L214](../summa/db.py#L198-L214)). One of the two guards is redundant,
and the migrations live between table creation and index creation, which makes
the function long.

**Suggestion:** use `with db_cursor() as cursor:`. Extract
`_migrate_invoice_columns(cursor)` with a small `(column, ddl)` table, which
drops the redundant `try`. The legacy item backfill
([L238-L254](../summa/db.py#L238-L254)) is idempotent but scans every active
invoice on every boot. That is cheap today; note it as a candidate for removal
once all deployments have run it.

## Cleanup and readability

### C1 — Literal hex colors that equal existing design tokens

`categorize.css` has 21 hex literals, and most of them are exact copies of
tokens in [static/css/variables.css](../static/css/variables.css):

| Literal   | Token                  | Used in                                                                                                                                                                                                               |
| --------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#6b5f4a` | `--text-secondary`     | [categorize.css L102](../static/css/categorize.css#L102), [L498](../static/css/categorize.css#L498)                                                                                                                   |
| `#8a7c62` | `--text-muted`         | [L196](../static/css/categorize.css#L196), [L214](../static/css/categorize.css#L214), [L465](../static/css/categorize.css#L465), [L479](../static/css/categorize.css#L479), [L512](../static/css/categorize.css#L512) |
| `#a3947a` | `--text-faint`         | [L118](../static/css/categorize.css#L118), [L153](../static/css/categorize.css#L153)                                                                                                                                  |
| `#e2d8c2` | `--border-color`       | [L106](../static/css/categorize.css#L106), [L133](../static/css/categorize.css#L133)                                                                                                                                  |
| `#fdf9f1` | `--bg-card`            | [L132](../static/css/categorize.css#L132)                                                                                                                                                                             |
| `#d9b8a2` | `--border-search-open` | [L22](../static/css/categorize.css#L22)                                                                                                                                                                               |
| `#e8dcc6` | `--bg-hero`            | [stats.css L121](../static/css/stats.css#L121)                                                                                                                                                                        |

The remaining literals (`#a5643c` three times, `#faf5e9` twice, `#f6ecda`,
`#e0bfae`, `#b39bd0`, and the stat-card text tones in `stats.css`) have no token
yet.

**Suggestion:** replace the exact matches with `var(…)`. For the recurring
remainder, add tokens such as `--ai-accent: #a5643c` and
`--bg-inset-warm: #faf5e9`. The first half has no visual effect; the second only
needs one screenshot comparison.

### C2 — Legacy token shim is half dead

[static/css/variables.css L94-L106](../static/css/variables.css#L94-L106)

The shim says it is "pruned in the final polish milestone once no rule
references them".

- **Unused:** `--bg-secondary`, `--success`, `--success-subtle` and
  `--shadow-lg` are no longer referenced anywhere.
- **Still used, with a canonical twin:**
  - `--bg-tertiary` (5 uses) equals `--bg-inset`
  - `--danger` (9 uses) equals `--danger-solid`
  - `--danger-subtle` (3 uses) equals `--danger-subtle-bg`

**Suggestion:** delete the four unused tokens now. Rename the three used
aliases at their call sites and delete them too. That leaves only
`--accent-hover` and `--accent-subtle`, which have no canonical twin; promote
them into the "Accents" group.

### C3 — Two different close-icon SVGs, five inline copies

[templates/partials/\_macros.html L11-L21](../templates/partials/_macros.html#L11-L21) ·
[bulk-toolbar.html L66](../templates/partials/bulk-toolbar.html#L66) ·
[filters.html L131](../templates/partials/filters.html#L131) ·
[filters.html L224](../templates/partials/filters.html#L224) ·
[sidebar.html L17](../templates/partials/sidebar.html#L17) ·
[add-invoice.html L94-L110](../templates/partials/modals/add-invoice.html#L94-L110)

`modal_close_button()` draws the X with two `<line>` elements. Four other
templates inline the same icon as `<path d="M18 6 6 18" />` +
`<path d="m6 6 12 12" />`, and the item-row remove button repeats the
`<line>` variant.

**Suggestion:** add an `icon_close(size=…)` macro and use it everywhere. This
matters most once R7 moves the item row into JS only.

### C4 — `state.js` mixes invoice, portfolio and chart state

[static/js/state.js L9-L31](../static/js/state.js#L9-L31)

The single `state` object holds several unrelated groups:

- invoice list paging and totals
- the invoice editing id
- import staging
- Chart.js instances for stats
- the portfolio range, depot and positions
- portfolio chart instances

Below it are about 15 further exports, some for portfolio and some for
invoices. To find out who owns a field, you have to grep.

**Suggestion:** at least group the object by concern with section comments, or
split it into `invoiceState`, `statsState` and `portfolioState` (all exported
from `state.js` to keep imports stable). Move module-private values, such as the
chart instances that only `stats.js` touches, into their modules. This is
medium risk only because of the number of call sites; it is mechanical.

### C5 — `chartColors` duplicates `--chart-1…8`

[static/js/state.js L64-L73](../static/js/state.js#L64-L73) ·
[static/css/variables.css](../static/css/variables.css)

The palette is maintained twice, and the comment even names the CSS tokens.

**Suggestion:** read the tokens once at chart creation with
`getComputedStyle(document.documentElement).getPropertyValue("--chart-N")`, or
accept the duplication and add a unit test that parses `variables.css` and
asserts both lists are equal.

### C6 — Pluralization and small repetitions

- `` `${n} invoice${n !== 1 ? "s" : ""}` `` appears six times
  ([bulk.js L228](../static/js/bulk.js#L228), [L329](../static/js/bulk.js#L329),
  [categorize.js L191](../static/js/categorize.js#L191),
  [L270](../static/js/categorize.js#L270), [L577](../static/js/categorize.js#L577),
  [render.js L239](../static/js/render.js#L239)). A
  `pluralize(count, "invoice")` in `dom.js`, or `Intl.PluralRules`, removes the
  noise.
- [bulk-edit.html L16](../templates/partials/modals/bulk-edit.html#L16) says
  "invoice(s) selected" while the rest of the UI pluralizes properly. Set the
  whole phrase from JS.

### C7 — Minor backend readability points

- `stats.py` uses `assert row is not None` twice
  ([L42](../summa/routes/stats.py#L42), [L84](../summa/routes/stats.py#L84)) as a
  mypy narrowing device. Under `python -O` the asserts vanish; the aggregate
  really does always return a row, so this is harmless. `typing.cast` states the
  intent more honestly, and so does
  `COALESCE(SUM(total), 0)` (which also removes the `or 0` fallbacks at
  [L43](../summa/routes/stats.py#L43) and [L86](../summa/routes/stats.py#L86)).
- `_calculate_comparison()` repeats the `"%Y-%m-%d"` literal four times.
  `date.fromisoformat()` and `date.isoformat()` remove it entirely.
- `summa/db.py` reads `DATABASE_PATH` at import time
  ([L14](../summa/db.py#L14)). Every other env value is read inside an accessor
  in `summa/config.py`, which is the pattern `CLAUDE.md` describes. Tests work
  around it by patching `db.DATABASE`. Moving it to `config.database_path()` makes
  the convention hold everywhere, but it is optional.
- `import_invoices()` runs one duplicate-check `SELECT` per entry (up to
  `MAX_IMPORT_BATCH` = 10 000). The partial `(date)` index keeps this fast
  enough. If imports ever get slow, a single
  `SELECT date, store, total … WHERE date BETWEEN min AND max` into a Python set
  is the fix. No action needed now.

### C8 — Test helper duplication

[tests/test_invoices_api.py L14-L16](../tests/test_invoices_api.py#L14-L16),
[L84-L86](../tests/test_invoices_api.py#L84-L86) ·
[tests/test_stats_api.py L12-L14](../tests/test_stats_api.py#L12-L14) ·
[tests/test_helpers.py L18](../tests/test_helpers.py#L18)

`_get_json()` is defined in two files and `_valid_items()` in two files.

**Suggestion:** move both into `tests/conftest.py` (or a `tests/payloads.py`)
and import them.

## Documentation drift

### D1 — `CLAUDE.md` describes an `/* exported */` directive that is gone

[CLAUDE.md L94-L95](../CLAUDE.md#L94-L95)

The text says that functions called from inline HTML handlers are listed in a
top-of-file `/* exported … */` directive in `app.js`. There are no inline
handlers left in `templates/`, and `app.js` has no such directive; everything is
wired with `addEventListener` or `data-action`.

**Suggestion:** delete the sentence, or replace it with "no inline event
handlers; wire through `data-action`".

### D2 — `CLAUDE.md` ESLint scope is out of date

[CLAUDE.md L88-L91](../CLAUDE.md#L88-L91)

The text says ESLint lints `static/js/app.js` and `static/sw.js`.
[eslint.config.js](../eslint.config.js) actually covers:

- `static/js/**/*.js`
- `boot-view.js` as a classic script
- `sw.js`
- the two config files
- `scripts/**/*.{js,mjs}`
- `tests/frontend/**`
- `templates/**/*.html`

### D3 — `CLAUDE.md` CSS file list is out of date

[CLAUDE.md L214-L215](../CLAUDE.md#L214-L215)

The list names `header`, but there is no `header.css`. It also omits
`categorize`, `combobox`, `fonts`, `login`, `settings`, `shortcuts-help`,
`sidebar`, `toast` and `utilities`.

**Suggestion:** either list them all or say "one file per component; the
`<link>` order in `templates/index.html` is authoritative".

### D4 — `CLAUDE.md` CI and test descriptions omit the Vitest suite

[CLAUDE.md](../CLAUDE.md) says "The backend has a `pytest` suite" and that the
CI `frontend` job runs `npm run lint`. The repository also has a Vitest suite
(`tests/frontend/`, 30 files, `npm run test`), and
[.github/workflows/ci.yml L79](../.github/workflows/ci.yml#L79) runs it in the
same job. Neither the Commands section nor the CI paragraph mentions it.

## Rejected: checked and fine

These came up as candidates and did not hold up. They are recorded so they are
not raised again.

- **"`--cat-lebensmittel` / `--cat-unterkunft` are unused":** wrong.
  `categoryColorVar()` in `static/js/dom.js` builds the variable name at runtime
  (see `tests/frontend/dom.test.js`).
- **"Modal, drawer and sheet each manage scroll lock":** wrong. `lockScroll()`
  and `unlockScroll()` in `static/js/modals.js` are the only writers, and
  `drawer.js` imports them.
- **"No `.stylelintrc.json` exists":** wrong. It exists at the repo root.
- **"XSS via `innerHTML`":** every interpolated user value in `render.js`,
  `import.js`, `categorize.js` and `combobox.js` goes through `escapeHtml()`.
  The `${message}` in `renderPageScopedEmpty()` only carries a number. No
  action.
- **"Move the per-file `mount*Fixture()` helpers into `tests/frontend/helpers.js`":**
  each is used by a single test file, so moving them adds indirection for no
  reuse.
- **"Invoice items should be merged instead of replaced on update":** the
  replace-all in `update_invoice()` is simpler and invoices are small. Keep it.
- **"Add a migration registry":** two column migrations do not justify one. R8
  covers the part that is worth doing.

## Suggested order

1. **B1 to B6.** Each is small, self-contained and should ship with a test.
2. **Backend refactor:** R1 (it also closes B3), then R3, R4 and R8. These are
   mechanical and the pytest suite covers them fully.
3. **R2.** Easier once R1 and R3 have removed the noise around it.
4. **CSS cleanup:** C1 and C2 in one change, with a screenshot regeneration at
   the end of the branch.
5. **Frontend refactor:** R7 with C3, then R5, then R6 (each on its own, running
   Vitest after each).
6. **The rest:** C4 to C8 and D1 to D4, whenever those files are touched anyway.
