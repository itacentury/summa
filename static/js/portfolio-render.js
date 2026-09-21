/**
 * Portfolio numbers and markup: the amount vocabulary, the summary cards, the
 * depot groups and the position rows.
 *
 * Pure module — every export either formats or parses a number, or takes a
 * slice of the `GET /api/portfolio` payload and returns an HTML string. Nothing
 * here touches the DOM, `fetch` or `state`, so each rule below is provable
 * without mounting the view. Imports only from `dom.js`, which is itself a leaf.
 */

import { escapeHtml } from "./dom.js";

// The API sends the lowercase enum the schema's CHECK constraint holds; the row
// meta line shows it the way the design spells it.
export const KIND_LABELS = new Map([
  ["etf", "ETF"],
  ["fund", "Fund"],
  ["stock", "Stock"],
]);

// Grouped thousands with exactly two decimals (`1,300.00`). `formatCurrency()`
// in dom.js is the invoice side's formatter and has no grouping at all.
const amountFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a number as a grouped amount without any currency symbol.
 *
 * `value === 0` normalizes a negative zero (which the backend's rounding can
 * produce) back to zero, so it never renders as `-0.00`.
 */
export function formatAmount(value) {
  return amountFormat.format(value === 0 ? 0 : value);
}

/** Format an EUR amount with a leading symbol (`€ 16,810.72`) — cards and subtotals. */
export function formatEuroPrefixed(value) {
  return `€ ${formatAmount(value)}`;
}

/** Format an EUR amount with a trailing symbol (`1,389.27 €`) — list cells. */
export function formatEuroSuffixed(value) {
  return `${formatAmount(value)} €`;
}

/**
 * Format a gain or loss with an explicit sign (`+89.27 €`, `-12.00 €`).
 *
 * The sign is written out and the magnitude formatted separately, so a negative
 * value cannot pick up a second minus from the number formatter.
 */
export function formatSigned(value) {
  const sign = value < 0 ? "-" : "+";
  return `${sign}${formatAmount(Math.abs(value))} €`;
}

/**
 * Format a percentage with an explicit sign, or an em dash when it is undefined.
 *
 * `gain_pct` is null whenever nothing was ever contributed — there is no basis
 * to measure against, which is not the same as zero.
 */
export function formatPercent(value) {
  if (value === null || value === undefined) return "—";
  const sign = value < 0 ? "-" : "+";
  return `${sign}${Math.abs(value).toFixed(1)} %`;
}

/**
 * Format an ISO day as `DD.MM.YYYY`.
 *
 * Split rather than parsed: no Date is built, so no timezone can shift the day.
 * The invoice side's `formatDate()` renders en-GB `DD/MM/YYYY` and stays as it is.
 */
export function formatDateDots(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

/**
 * Whether a number written with a single kind of separator groups perfectly into
 * thousands (`1.234`, `12,345,678`) — the only shape that cannot be a fraction.
 */
function isGroupedThousands(text, separator) {
  const pattern =
    separator === "," ? /^-?\d{1,3}(,\d{3})+$/ : /^-?\d{1,3}(\.\d{3})+$/;
  return pattern.test(text);
}

/**
 * Parse an amount a user typed, in either German or English notation.
 *
 * The snapshot form is the one place where numbers travel the other way, and the
 * user's own spreadsheet writes `1.234,56` while the app renders `1,234.56` — so
 * both have to read as the same amount. With both separators present the later
 * one is the decimal point. A single kind is ambiguous (`1.234` is thousands,
 * `12.34` a fraction), and is read as grouping only when the digits group
 * perfectly, which no two-decimal fraction does.
 *
 * Returns `null` for a blank field — the API's "carry the previous value
 * forward" signal, which is not the same as zero — and `NaN` for anything
 * unparseable, so a caller can tell the two apart.
 */
export function parseAmountInput(text) {
  const cleaned = String(text ?? "").replace(/[\s\u00a0\u202f\p{Sc}]/gu, "");
  if (cleaned === "") return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? "," : ".";
    normalized = isGroupedThousands(cleaned, separator)
      ? cleaned.split(separator).join("")
      : cleaned.replace(separator, ".");
  }

  // A full-string test rather than parseFloat(), which would read `12abc` as 12
  // and a stray second separator as a silently truncated number.
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

/** Map a signed amount onto its colour class, so the palette stays in CSS. */
export function toneClass(value) {
  if (value > 0) return "is-gain";
  if (value < 0) return "is-loss";
  return "";
}

/** Pluralize a count with its noun (`1 position`, `9 positions`). */
function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Build the sub-line of the Invested card.
 *
 * `contributed_eur` is the headline: lifetime money paid in, and the basis
 * `gain_pct` is measured against. `invested_eur` is the signed net still at
 * work, which only diverges once something has been sold — so it is named
 * explicitly in that case and left out otherwise, where it would just repeat
 * the number above it.
 */
function investedSubLine(totals) {
  const counts = `${pluralize(totals.position_count, "position")} · ${pluralize(
    totals.depot_count,
    "depot",
  )}`;
  if (totals.invested_eur === totals.contributed_eur) return counts;
  // Its own line rather than a fourth `·` segment: the card is the narrowest of
  // the three, and one more segment wraps it taller than its neighbours.
  return `<span class="portfolio-card-net">net ${formatEuroPrefixed(
    totals.invested_eur,
  )}</span>${counts}`;
}

/**
 * Build the three summary cards: portfolio value, invested, last week.
 */
export function summaryCardsHtml(totals) {
  const gainTone = toneClass(totals.gain);
  const weekTone = toneClass(totals.week_delta);
  const snapshotNote = totals.last_snapshot_date
    ? `snapshot ${formatDateDots(totals.last_snapshot_date)}`
    : "no snapshot yet";

  return `
    <div class="portfolio-card portfolio-card-hero">
      <div class="portfolio-card-label">Portfolio value</div>
      <div class="portfolio-hero-value">${formatEuroPrefixed(totals.value_eur)}</div>
      <div class="portfolio-hero-change">
        <span class="portfolio-chip ${gainTone}">${formatSigned(totals.gain)}</span>
        <span class="portfolio-hero-percent ${gainTone}">${formatPercent(totals.gain_pct)}</span>
        <span class="portfolio-hero-note">all-time</span>
      </div>
    </div>
    <div class="portfolio-card">
      <div class="portfolio-card-label">Invested</div>
      <div class="portfolio-card-value portfolio-card-value-amount">${formatEuroPrefixed(
        totals.contributed_eur,
      )}</div>
      <div class="portfolio-card-sub">${investedSubLine(totals)}</div>
    </div>
    <div class="portfolio-card">
      <div class="portfolio-card-label">Last week</div>
      <div class="portfolio-card-value ${weekTone}">${formatSigned(totals.week_delta)}</div>
      <div class="portfolio-card-sub">${snapshotNote}</div>
    </div>
  `;
}

/**
 * Build a position's meta line: kind, currency, and the dates that qualify it.
 *
 * `since` appears only for a position whose history starts inside the selected
 * window — elsewhere it would be on every row and say nothing.
 */
function positionMeta(position, rangeStart) {
  const parts = [
    KIND_LABELS.get(position.kind) ?? position.kind,
    position.currency,
  ];
  if (
    position.first_snapshot_date &&
    rangeStart &&
    position.first_snapshot_date > rangeStart
  ) {
    parts.push(`since ${formatDateDots(position.first_snapshot_date)}`);
  }
  if (position.closed_at) {
    parts.push(`sold ${formatDateDots(position.closed_at)}`);
  }
  return escapeHtml(parts.join(" · "));
}

/**
 * Build one position row.
 *
 * A disclosure button rather than a div: the detail strip is a sibling it
 * reveals, so the row is focusable and operable from the keyboard without the
 * roving-tabindex machinery the invoice list needs. Its children are spans
 * because a `<button>` may only contain phrasing content.
 */
export function positionRowHtml(
  position,
  { rangeStart = null, expanded = false } = {},
) {
  const tone = toneClass(position.gain);
  const badge = position.is_benchmark_fallback
    ? '<span class="portfolio-badge">Benchmark fallback</span>'
    : "";

  return `
    <button type="button" class="portfolio-row${position.closed_at ? " is-closed" : ""}"
            data-position-id="${position.id}" aria-expanded="${expanded}"
            aria-controls="portfolio-detail-${position.id}">
      <span class="portfolio-row-main">
        <span class="portfolio-row-name">${escapeHtml(position.name)}${badge}</span>
        <span class="portfolio-row-meta">${positionMeta(position, rangeStart)}</span>
      </span>
      <span class="portfolio-row-invested">${formatEuroSuffixed(position.invested_eur)}</span>
      <span class="portfolio-row-value">${formatEuroSuffixed(position.value_eur)}</span>
      <span class="portfolio-row-gain ${tone}">${formatSigned(position.gain)}</span>
      <span class="portfolio-row-percent ${tone}">${formatPercent(position.gain_pct)}</span>
    </button>
  `;
}

/**
 * Build the detail strip revealed under an expanded row.
 *
 * Rendered as a sibling of the row, never inside it, so expanding cannot move
 * a single cell of the row itself (the same rule the invoice list follows).
 *
 * Always rendered, merely collapsed to zero height, because the row's
 * `aria-controls` has to resolve to an element even before anything is opened.
 * The inner wrapper is what the open/close transition clips (see portfolio.css).
 *
 * `Invested` is the one item the desktop row already carries in a column of its
 * own; it is shown here only on mobile, where the open row gives that line up to
 * the meta text.
 */
export function positionDetailHtml(position, { open = false } = {}) {
  const weekDelta =
    position.week_delta === null ? "—" : formatSigned(position.week_delta);
  const weekTone =
    position.week_delta === null ? "" : toneClass(position.week_delta);

  return `
    <div class="portfolio-detail${open ? " is-open" : ""}" id="portfolio-detail-${position.id}"${open ? "" : " inert"}>
      <div class="portfolio-detail-inner">
        <div class="portfolio-detail-items">
          <div class="portfolio-detail-item">
            <div class="portfolio-detail-label">Original</div>
            <div class="portfolio-detail-value">${escapeHtml(position.currency)} ${formatAmount(
              position.value,
            )}</div>
          </div>
          <div class="portfolio-detail-item">
            <div class="portfolio-detail-label">FX rate</div>
            <div class="portfolio-detail-value">${position.fx_rate.toFixed(4)}</div>
          </div>
          <div class="portfolio-detail-item is-mobile-only">
            <div class="portfolio-detail-label">Invested</div>
            <div class="portfolio-detail-value">${formatEuroSuffixed(
              position.invested_eur,
            )}</div>
          </div>
          <div class="portfolio-detail-item">
            <div class="portfolio-detail-label">Last week</div>
            <div class="portfolio-detail-value ${weekTone}">${weekDelta}</div>
          </div>
          <div class="portfolio-detail-item">
            <div class="portfolio-detail-label">Snapshots</div>
            <div class="portfolio-detail-value">${position.snapshot_count}</div>
          </div>
          <div class="portfolio-detail-item portfolio-detail-action">
            <button type="button" class="btn btn-secondary btn-sm" data-action="show-history"
                    data-position-id="${position.id}" data-position-name="${escapeHtml(position.name)}">
              History
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Build the rows of the history dialog, newest first.
 *
 * The default view keeps only the weeks money moved in or out, which is what
 * "transactions" means here; every other week is a pure valuation. The derived
 * closing row of a sold position always survives that filter — it is the sale.
 *
 * A week whose value was copied forward is marked, and a value in a foreign
 * currency shows the native amount next to the EUR one, so a jump caused by the
 * FX rate alone stays readable.
 */
export function historyRowsHtml(
  rows,
  { currency = "EUR", paymentsOnly = true } = {},
) {
  const shown = paymentsOnly
    ? rows.filter((row) => row.deposit !== 0 || row.derived)
    : rows;
  if (!shown.length) {
    return `<p class="portfolio-history-empty">${
      rows.length ? "No payments recorded." : "No weeks recorded yet."
    }</p>`;
  }

  // Two unlabelled money columns would be indistinguishable: one is what was
  // paid in or taken out, the other what the market did.
  const header = `
    <div class="portfolio-history-row portfolio-history-header">
      <span class="portfolio-history-date">Week</span>
      <span class="portfolio-history-deposit">Payment</span>
      <span class="portfolio-history-change">Change</span>
    </div>
  `;

  const body = shown
    .map((row) => {
      const native =
        currency === "EUR"
          ? ""
          : `<span class="portfolio-history-native">${escapeHtml(currency)} ${formatAmount(
              row.value,
            )}</span>`;
      const label = row.derived
        ? '<span class="portfolio-badge">Sale</span>'
        : row.carried
          ? '<span class="portfolio-badge">Carried forward</span>'
          : "";
      const deposit =
        row.deposit_eur === 0 ? "—" : formatSigned(row.deposit_eur);
      const change = row.change === null ? "—" : formatSigned(row.change);

      return `
        <div class="portfolio-history-row">
          <span class="portfolio-history-date">${formatDateDots(row.date)}${label}</span>
          <span class="portfolio-history-value">${formatEuroSuffixed(
            row.value_eur,
          )}${native}</span>
          <span class="portfolio-history-deposit ${toneClass(
            row.deposit_eur,
          )}">${deposit}</span>
          <span class="portfolio-history-change ${
            row.change === null ? "" : toneClass(row.change)
          }">${change}</span>
        </div>
      `;
    })
    .join("");

  return header + body;
}

/**
 * Build one depot group: its collapsible header carrying the subtotal, and its
 * rows (each followed by its detail strip when open).
 */
export function depotGroupHtml(
  depot,
  { rangeStart = null, collapsed = false, expanded } = {},
) {
  const tone = toneClass(depot.gain);
  const open = expanded ?? new Set();
  const rows = depot.positions
    .map((position) => {
      const isExpanded = open.has(position.id);
      return (
        positionRowHtml(position, { rangeStart, expanded: isExpanded }) +
        positionDetailHtml(position, { open: isExpanded })
      );
    })
    .join("");

  return `
    <div class="portfolio-group${collapsed ? " is-collapsed" : ""}" data-depot-id="${depot.id}">
      <button type="button" class="portfolio-group-header" aria-expanded="${!collapsed}"
              aria-controls="portfolio-group-body-${depot.id}">
        <svg class="portfolio-group-chevron" width="11" height="11" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span class="portfolio-group-label">${escapeHtml(depot.name)} · ${pluralize(
          depot.positions.length,
          "position",
        )}</span>
        <span class="portfolio-group-value">${formatEuroPrefixed(depot.value_eur)}</span>
        <span class="portfolio-group-gain ${tone}">${formatSigned(depot.gain)}</span>
        <span class="portfolio-group-percent ${tone}">${formatPercent(depot.gain_pct)}</span>
      </button>
      <div class="portfolio-group-body" id="portfolio-group-body-${depot.id}"${collapsed ? " inert" : ""}>
        <div class="portfolio-group-rows">${rows}</div>
      </div>
    </div>
  `;
}

/**
 * Build the list footer: the column legend and the grand total the groups above
 * have to add up to.
 *
 * The invested column carries `invested_eur`, not the `contributed_eur` of the
 * card above, so it is marked `net` the same way the card's sub-line is — the two
 * diverge as soon as anything is sold, and one unqualified "invested" on the
 * screen for both figures reads as a contradiction.
 */
export function listFooterHtml(totals) {
  return `
    <div class="portfolio-list-footer">
      <span class="portfolio-list-legend">Columns: position · net invested · value · gain/loss</span>
      <span class="portfolio-list-net">
        net
        <span class="portfolio-list-invested">${formatEuroSuffixed(totals.invested_eur)}</span>
      </span>
      <span class="portfolio-list-total">${formatEuroSuffixed(totals.value_eur)}</span>
    </div>
  `;
}

/**
 * Build the whole positions list card from the payload.
 */
export function positionsListHtml(
  payload,
  { collapsed = new Set(), expanded = new Set() } = {},
) {
  const groups = payload.depots
    .map((depot) =>
      depotGroupHtml(depot, {
        rangeStart: payload.range_start,
        collapsed: collapsed.has(depot.id),
        expanded,
      }),
    )
    .join("");
  return groups + listFooterHtml(payload.totals);
}

/**
 * Build the allocation legend rows.
 *
 * Nothing is recomputed here: `share_pct` arrives as a finished 0-100 figure and
 * the server has already capped the list at the top slices plus one pooled
 * entry, whose `label` reads `"4 more"`. The swatches are left uncoloured — their
 * fill is painted through the CSSOM in `portfolio-charts.js`, which a strict
 * `style-src` CSP requires.
 */
export function allocationLegendHtml(allocation) {
  if (allocation.length === 0)
    return '<div class="portfolio-card-empty">Nothing held in this period.</div>';

  return allocation
    .map((slice) => {
      const aggregated = slice.aggregated_count > 0 ? " is-aggregated" : "";
      return `
        <div class="portfolio-alloc-item${aggregated}">
          <span class="portfolio-alloc-color"></span>
          <span class="portfolio-alloc-label">${escapeHtml(slice.label)}</span>
          <span class="portfolio-alloc-percent">${slice.share_pct.toFixed(1)} %</span>
        </div>
      `;
    })
    .join("");
}

/**
 * Build the chart legend for a per-position selection.
 *
 * The swatches stay empty here: their colors come from the payload's position
 * order, which only the chart module knows, and are painted through the CSSOM
 * for the same CSP reason as the allocation swatches.
 *
 * @param {{label: string}[]} lines the drawn lines, in chart order.
 */
export function seriesLegendHtml(lines) {
  return lines
    .map(
      (line) => `
        <span class="portfolio-legend-item">
          <span class="portfolio-legend-bar is-series"></span>${escapeHtml(line.label)}
        </span>
      `,
    )
    .join("");
}

/**
 * Build one biggest-changes row.
 *
 * The bar's length rides on `data-share` rather than a style attribute, for the
 * same CSP reason as the allocation swatches.
 */
function changeRowHtml(change, largest) {
  const share = largest > 0 ? Math.abs(change.week_delta) / largest : 0;
  const tone = toneClass(change.week_delta);

  return `
    <div class="portfolio-change-row">
      <span class="portfolio-change-name">${escapeHtml(change.name)}</span>
      <span class="portfolio-bar-track">
        <span class="portfolio-bar-fill ${tone}" data-share="${share}"></span>
      </span>
      <span class="portfolio-change-amount ${tone}">${formatSigned(change.week_delta)}</span>
    </div>
  `;
}

/**
 * Build the biggest-changes list: gainers, then losers under a divider.
 *
 * Both halves are scaled against the single largest absolute move across the two
 * lists, so the longest gainer and the longest loser bar stay comparable instead
 * of each filling its own track.
 */
export function biggestChangesHtml({ gainers = [], losers = [] } = {}) {
  if (gainers.length === 0 && losers.length === 0)
    return '<div class="portfolio-card-empty">No movement in this period.</div>';

  const largest = [...gainers, ...losers].reduce(
    (max, change) => Math.max(max, Math.abs(change.week_delta)),
    0,
  );
  const gainerRows = gainers
    .map((change) => changeRowHtml(change, largest))
    .join("");
  const loserRows = losers
    .map((change) => changeRowHtml(change, largest))
    .join("");
  const divider =
    gainerRows && loserRows
      ? '<div class="portfolio-change-divider"></div>'
      : "";

  return gainerRows + divider + loserRows;
}

/**
 * Build the note under the value-over-time chart naming the benchmark's origin.
 *
 * A failed feed is not an error the user can act on — it only changes this one
 * sentence, which is why the fallback wording names the substitute rather than
 * the failure. Returns plain text, so the caller assigns it as `textContent`.
 */
export function benchmarkNoteText(source, updatedAt) {
  if (source === "fallback")
    return "Benchmark: own MSCI World SRI (index feed unavailable)";
  if (source === "feed")
    return `Benchmark from index feed · last updated ${formatDateDots(updatedAt)}`;
  return "";
}
