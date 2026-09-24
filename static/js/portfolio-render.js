/**
 * Portfolio markup: summary cards, depot groups, position rows, chart legends.
 * Pure: every export turns a payload slice into an HTML string, without DOM,
 * `fetch` or `state`.
 */

import { escapeHtml } from "./dom.js";
import { truncatableHtml } from "./truncate.js";
import {
  KIND_LABELS,
  formatAmount,
  formatDateDots,
  formatEuro,
  formatPercent,
  formatSigned,
  toneClass,
} from "./portfolio-format.js";

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Build the Invested card's sub-line. The net `invested_eur` only diverges from
 * `contributed_eur` after a sale, so it is shown only then.
 */
function investedSubLine(totals) {
  const counts = `${pluralize(totals.position_count, "position")} · ${pluralize(
    totals.depot_count,
    "depot",
  )}`;
  if (totals.invested_eur === totals.contributed_eur) return counts;
  // Its own line: a fourth `·` segment would wrap the narrowest card taller.
  return `<span class="portfolio-card-net">net ${formatEuro(
    totals.invested_eur,
  )}</span>${counts}`;
}

/** Build the three summary cards: portfolio value, invested, last week. */
export function summaryCardsHtml(totals) {
  const gainTone = toneClass(totals.gain);
  const weekTone = toneClass(totals.week_delta);
  const snapshotNote = totals.last_snapshot_date
    ? `snapshot ${formatDateDots(totals.last_snapshot_date)}`
    : "no snapshot yet";

  return `
    <div class="portfolio-card portfolio-card-hero">
      <div class="portfolio-card-label">Portfolio value</div>
      <div class="portfolio-hero-value">${formatEuro(totals.value_eur)}</div>
      <div class="portfolio-hero-change">
        <span class="portfolio-chip ${gainTone}">${formatSigned(totals.gain)}</span>
        <span class="portfolio-hero-percent ${gainTone}">${formatPercent(totals.gain_pct)}</span>
        <span class="portfolio-hero-note">all-time</span>
      </div>
    </div>
    <div class="portfolio-card">
      <div class="portfolio-card-label">Invested</div>
      <div class="portfolio-card-value portfolio-card-value-amount">${formatEuro(
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
 * Build a position's meta line. `since` appears only when history starts inside
 * the window. The fallback badge sits here, not on the clipping `nowrap` name
 * line; its full wording is in `title` and a `visually-hidden` span.
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

  const badge = position.is_benchmark_fallback
    ? '<span class="portfolio-badge" title="Benchmark fallback" aria-hidden="true">Fallback</span>' +
      '<span class="visually-hidden">Benchmark fallback</span>'
    : "";

  return `${escapeHtml(parts.join(" · "))}${badge}`;
}

/**
 * Build one position row: a disclosure button for its sibling detail strip, so
 * it is keyboard-operable as is. Children are spans (phrasing content only).
 */
export function positionRowHtml(
  position,
  { rangeStart = null, expanded = false } = {},
) {
  const tone = toneClass(position.gain);

  return `
    <button type="button" class="portfolio-row${position.closed_at ? " is-closed" : ""}"
            data-position-id="${position.id}" aria-expanded="${expanded}"
            aria-controls="portfolio-detail-${position.id}">
      <span class="portfolio-row-main">
        <span class="portfolio-row-name">${truncatableHtml(position.name)}</span>
        <span class="portfolio-row-meta">${positionMeta(position, rangeStart)}</span>
      </span>
      <span class="portfolio-row-invested">${formatEuro(position.invested_eur)}</span>
      <span class="portfolio-row-value">${formatEuro(position.value_eur)}</span>
      <span class="portfolio-row-gain ${tone}">${formatSigned(position.gain)}</span>
      <span class="portfolio-row-percent ${tone}">${formatPercent(position.gain_pct)}</span>
    </button>
  `;
}

/**
 * Build the detail strip: a sibling of the row so expanding moves no cell, and
 * always rendered so the row's `aria-controls` resolves. `Invested` is
 * mobile-only; the desktop row has a column for it.
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
            <div class="portfolio-detail-value">${formatEuro(
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
 * Build the history dialog rows, newest first. `paymentsOnly` keeps weeks with a
 * deposit plus the derived sale row; a foreign value also shows its native amount.
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

  // Labelled, because the two money columns would otherwise look alike.
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
          <span class="portfolio-history-value">${formatEuro(
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

/** Build one collapsible depot group with its subtotal and rows. */
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
        <span class="portfolio-group-value">${formatEuro(depot.value_eur)}</span>
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
 * Build the list footer. Its invested column is the net `invested_eur`, so it is
 * marked `net` to avoid contradicting the card's `contributed_eur`.
 */
export function listFooterHtml(totals) {
  return `
    <div class="portfolio-list-footer">
      <span class="portfolio-list-legend">Columns: position · net invested · value · gain/loss</span>
      <span class="portfolio-list-net">
        net
        <span class="portfolio-list-invested">${formatEuro(totals.invested_eur)}</span>
      </span>
      <span class="portfolio-list-total">${formatEuro(totals.value_eur)}</span>
    </div>
  `;
}

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
 * Build the allocation legend rows from the server's finished `share_pct`. The
 * swatches stay uncoloured: the CSP forces a CSSOM paint in `portfolio-charts.js`.
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
          <span class="portfolio-alloc-label">${truncatableHtml(slice.label)}</span>
          <span class="portfolio-alloc-percent">${slice.share_pct.toFixed(1)} %</span>
        </div>
      `;
    })
    .join("");
}

/**
 * Build the chart legend for a per-position selection; the chart module paints
 * the swatches through the CSSOM.
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

/** Build one biggest-changes row; the bar length rides on `data-share` for the CSP. */
function changeRowHtml(change, largest) {
  const share = largest > 0 ? Math.abs(change.week_delta) / largest : 0;
  const tone = toneClass(change.week_delta);

  return `
    <div class="portfolio-change-row">
      <span class="portfolio-change-name">${truncatableHtml(change.name)}</span>
      <span class="portfolio-bar-track">
        <span class="portfolio-bar-fill ${tone}" data-share="${share}"></span>
      </span>
      <span class="portfolio-change-amount ${tone}">${formatSigned(change.week_delta)}</span>
    </div>
  `;
}

/**
 * Build the biggest-changes list: gainers, then losers. Both scale against the
 * single largest move, so their bars stay comparable.
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

/** Readable names for known feed tickers; an unlisted ticker shows as itself. */
const BENCHMARK_FEED_LABELS = new Map([
  ["EUNL.DE", "MSCI World (iShares Core)"],
]);

/** Name the benchmark line's source: the feed's index, or the stand-in position. */
export function benchmarkDisplayName(source, name) {
  if (!name) return "";
  if (source === "fallback") return name;
  if (source === "feed") return BENCHMARK_FEED_LABELS.get(name) ?? name;
  return "";
}

/**
 * Build the plain-text note naming the benchmark's origin. It is the only place
 * touch devices see the source, since the legend's title needs a hover.
 */
export function benchmarkNoteText(source, updatedAt, name) {
  const displayName = benchmarkDisplayName(source, name);
  if (source === "fallback") {
    const subject = displayName
      ? `own position ${displayName}`
      : "an own position";
    return `Benchmark: ${subject} (index feed unavailable)`;
  }
  if (source === "feed") {
    const subject = displayName ? `${displayName} · ` : "";
    return `Benchmark: ${subject}index feed, last updated ${formatDateDots(updatedAt)}`;
  }
  return "";
}
