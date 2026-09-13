# Screenshots

A small, curated set — one screenshot per surface that shows something the
others don't. Most are desktop (1280×900); the two that carry a genuinely
different mobile layout are captured at 390×844 instead. All at 2× device pixel
ratio.

## Index

| File                              | Surface                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `invoice-list-expanded-desktop`   | The invoice list with a row expanded to its line items   |
| `stats-desktop`                   | Statistics: summary cards, category doughnut, top stores |
| `filter-panel-desktop`            | The filter panel expanded                                |
| `new-invoice-filled-desktop`      | New invoice with line items and calculated total         |
| `bulk-selection-desktop`          | Multi-select with the bulk action toolbar                |
| `categorize-row-expanded-desktop` | AI category suggestions, one row showing its items       |
| `import-empty-desktop`            | Import: dropzone and paste box                           |
| `import-errors-desktop`           | Import: per-entry error correction                       |
| `login-desktop`                   | The optional password gate                               |
| `invoice-list-expanded-mobile`    | The same list at phone width, with topbar and FAB        |
| `drawer-mobile`                   | The navigation drawer with its scrim                     |

## Regenerating

The capture run starts its own dev server against a throwaway database, so the
repository's `invoices.db` is never touched. It also clears this folder's PNGs
first, so what remains is exactly what the script produces. Playwright is
deliberately not a dependency of this repo — install it once outside it:

```bash
mkdir -p /tmp/summa-pw && cd /tmp/summa-pw && npm init -y && npm i playwright
npx playwright install chromium

cd /path/to/summa
NODE_PATH=/tmp/summa-pw/node_modules node scripts/screenshots.mjs
```

The demo data lives in [`scripts/screenshot-data.json`](../../scripts/screenshot-data.json)
(45 invoices across ~14 months). Its dates are absolute — so the file doubles as
a ready-to-use `POST /api/invoices/import` sample — but the script shifts them
forward by whole months at seed time, so the default "Month" filter always has
data. [`scripts/screenshot-import-sample.json`](../../scripts/screenshot-import-sample.json)
is the smaller file that drives the import modal; two of its entries are invalid
on purpose, to produce the error-correction panel.

The AI suggestion endpoint is stubbed via `page.route()`, so the run needs no
Anthropic API key and stays deterministic.

The committed PNGs are reduced to a 256-colour palette, which is visually
identical for this flat-coloured UI at about a third of the size. The run does
that itself when `pngquant`, `oxipng` or ImageMagick is installed, and tells you
when none of them is.
