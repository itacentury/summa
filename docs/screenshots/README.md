# Screenshots

A small, curated set — one screenshot per surface that shows something the
others don't. Most are desktop (1280×900); the two that carry a genuinely
different mobile layout are captured at 390×844 instead. All at 2× device pixel
ratio.

## Index

| File                              | Surface                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `invoice-list-expanded-desktop`   | The invoice list with a row expanded to its line items    |
| `stats-desktop`                   | Statistics: summary cards, category doughnut, top stores  |
| `filter-panel-desktop`            | The filter panel expanded                                 |
| `new-invoice-filled-desktop`      | New invoice with line items and calculated total          |
| `bulk-selection-desktop`          | Multi-select with the bulk action toolbar                 |
| `categorize-row-expanded-desktop` | AI category suggestions, one row showing its items        |
| `import-empty-desktop`            | Import: dropzone and paste box                            |
| `import-errors-desktop`           | Import: per-entry error correction                        |
| `login-desktop`                   | The optional password gate                                |
| `portfolio-overview-desktop`      | Portfolio: summary cards and the value-over-time chart    |
| `portfolio-positions-desktop`     | Portfolio: a position expanded, allocation, weekly movers |
| `invoice-list-expanded-mobile`    | The same list at phone width, with topbar and FAB         |
| `portfolio-mobile`                | The portfolio at phone width, with its snapshot FAB       |
| `drawer-mobile`                   | The navigation drawer with its scrim                      |

## Regenerating

The capture run starts its own dev server against a throwaway database, so the
repository's `invoices.db` is never touched — and it aborts up front rather than
screenshot a server it did not start, so stop any dev server on port 8000 first.
Screenshots go to a work directory; only after every surface has succeeded are
this folder's PNGs dropped and replaced, so what remains is exactly what the
script produces and a failed run leaves the folder as committed. Browser and
image tooling are pinned in a separate package so the regular frontend install
and CI job stay small. Set them up once:

```bash
npm run screenshots:setup
```

After changing the compression pass, run its focused tests:

```bash
npm test --prefix scripts/screenshots
```

Regenerate the full set whenever a captured UI surface changes:

```bash
npm run screenshots
```

The demo data lives in [`scripts/screenshot-data.json`](../../scripts/screenshot-data.json)
(45 invoices across 13 months, 2025-09 to 2026-09). Its dates are absolute — so the file doubles as
a ready-to-use `POST /api/invoices/import` sample — but the script shifts them
forward by whole months at seed time, so the default "Month" filter always has
data. [`scripts/screenshot-import-sample.json`](../../scripts/screenshot-import-sample.json)
is the smaller file that drives the import modal; two of its entries are invalid
on purpose, to produce the error-correction panel.

The portfolio side has no import endpoint, so its history comes from
[`scripts/seed_portfolio.py`](../../scripts/seed_portfolio.py), which the run
calls before it starts the server — the generator is deterministic, and the run
pins both `--seed` and `--weeks`, so the same chart comes out every time.

The AI suggestion endpoint is stubbed via `page.route()`, so the run needs no
Anthropic API key and stays deterministic.

The committed PNGs are quantized to a 256-colour palette, which is visually
identical for this flat-coloured UI at about a third of the size. The run does
that itself with the pinned Sharp package and keeps the original capture when
quantization would make an individual file larger. If the compression pass
fails, the run leaves the committed screenshots untouched.
