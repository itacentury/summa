/**
 * Portfolio visualisations: the value-over-time line, the allocation doughnut
 * and the biggest-changes bars.
 *
 * The markup strings come from `portfolio-render.js`; this module owns the DOM,
 * the vendored global `Chart` and the CSSOM writes a strict `style-src` CSP
 * forces on anything data-driven. Every chart is destroyed before it is
 * recreated, because a period or depot switch re-enters this path.
 */

import { state, chartColors } from "./state.js";
import { mobileViewport } from "./dom.js";
import {
  allocationLegendHtml,
  benchmarkNoteText,
  biggestChangesHtml,
  formatAmount,
} from "./portfolio-render.js";

// Whole euros on the axis: the two decimals the cards and rows carry are noise
// at tick size, and the design leaves the y labels deliberately quiet.
const axisFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

// Canvas cannot resolve CSS custom properties, so the series carry the literal
// hex behind --accent, --chart-4 and --chart-7. The header legend does use the
// tokens: its three bars are fixed markup, not data.
const PORTFOLIO_COLOR = "#c98d6b";
const INVESTED_COLOR = "#b5a184";
const BENCHMARK_COLOR = "#a3c2c2";

// Gridlines, ticks and the tooltip, likewise as literal hex.
const GRID_COLOR = "#efe7d5";
const TICK_COLOR = "#a3947a";
const MONO_FONT = { size: 10.5, family: "'JetBrains Mono', monospace" };
const TOOLTIP_STYLE = {
  backgroundColor: "#fdf9f1",
  titleColor: "#3a332a",
  bodyColor: "#6b5f4a",
  borderColor: "#e2d8c2",
  borderWidth: 1,
  padding: 12,
};

const TICK_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// A phone fits roughly half the labels before they collide; `autoSkip` cannot
// thin them out because the ticks are placed by hand below.
const MAX_AXIS_TICKS = 6;
const MAX_AXIS_TICKS_MOBILE = 3;

// UTC has no DST, so a week is always exactly seven fixed-length days.
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Convert an ISO day to epoch milliseconds at UTC midnight.
 *
 * Assembled from the split parts rather than parsed, so the local timezone can
 * never move a snapshot onto the neighbouring day — the same care
 * `formatDateDots()` takes on the render side.
 */
function isoToMs(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Format an axis tick as `Oct 25` — month name plus two-digit year. */
function formatTick(ms) {
  const date = new Date(ms);
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${TICK_MONTHS[date.getUTCMonth()]} ${year}`;
}

/** Format an axis tick as `02 Sep` — day and month, for a sub-month window. */
function formatDayTick(ms) {
  const date = new Date(ms);
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${day} ${TICK_MONTHS[date.getUTCMonth()]}`;
}

/** Format a tooltip title as `06.09.2026`, matching the dates in the list. */
function formatTooltipDate(ms) {
  const date = new Date(ms);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

/** Step a UTC timestamp to the first of the following month. */
function nextMonthStart(ms) {
  const at = new Date(ms);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/** The month starts inside the window, ascending. */
function monthTicks(minMs, maxMs) {
  const first = new Date(minMs);
  // The window's own month counts when it opens exactly on the 1st — which is
  // what "ytd" does every January.
  let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  if (cursor < minMs) cursor = nextMonthStart(cursor);

  const starts = [];
  while (cursor <= maxMs) {
    starts.push(cursor);
    cursor = nextMonthStart(cursor);
  }
  return starts;
}

/** The Monday starts inside the window, ascending. */
function weekTicks(minMs, maxMs) {
  const days = (8 - new Date(minMs).getUTCDay()) % 7;
  const mondays = [];
  for (let cursor = minMs + days * DAY_MS; cursor <= maxMs; cursor += WEEK_MS) {
    mondays.push(cursor);
  }
  return mondays;
}

/** Keep at most `limit` values, evenly spaced across the list. */
function thin(values, limit) {
  if (values.length <= limit) return values;
  const step = Math.ceil(values.length / limit);
  return values.filter((_, index) => index % step === 0);
}

/**
 * Pick the x-axis ticks and the resolution to label them in.
 *
 * A linear scale would otherwise place them on round millisecond values, which
 * land mid-month and collapse into duplicate `Oct 25` labels once formatted.
 * This is label placement only — the window itself still comes from the server.
 *
 * Month starts carry every window wide enough to hold one. Below that (an early
 * January under "ytd", a "max" over days of history) there is no month boundary
 * to place, and an empty tick list renders the axis bare — so the fallback steps
 * down to weeks, then to the window ends, and the labels step down with it.
 *
 * @returns {{values: number[], daily: boolean}} ticks, and whether they need the
 *   day-resolution format.
 */
export function axisTicks(minMs, maxMs, limit) {
  const months = monthTicks(minMs, maxMs);
  if (months.length > 0) return { values: thin(months, limit), daily: false };

  const weeks = weekTicks(minMs, maxMs);
  const ends = minMs === maxMs ? [minMs] : [minMs, maxMs];
  return { values: thin(weeks.length > 1 ? weeks : ends, limit), daily: true };
}

/** Zip a value series onto the shared date grid as `{x, y}` points. */
function seriesPoints(dates, values) {
  return dates.map((date, index) => ({ x: isoToMs(date), y: values[index] }));
}

/**
 * Build the line datasets.
 *
 * The benchmark is appended only when it has values: the server rebases it onto
 * the same grid or returns nothing at all, so the third line is either fully
 * aligned or absent — never partially.
 */
function valueDatasets(series) {
  const datasets = [
    {
      label: "Portfolio",
      data: seriesPoints(series.dates, series.portfolio),
      borderColor: PORTFOLIO_COLOR,
      borderWidth: 2.5,
    },
    {
      label: "Invested",
      data: seriesPoints(series.dates, series.invested),
      borderColor: INVESTED_COLOR,
      borderWidth: 2,
      borderDash: [5, 5],
    },
  ];

  if (series.benchmark.length > 0) {
    datasets.push({
      label: "MSCI World",
      data: seriesPoints(series.dates, series.benchmark),
      borderColor: BENCHMARK_COLOR,
      borderWidth: 2,
    });
  }

  return datasets.map((dataset) => ({
    ...dataset,
    tension: 0,
    fill: false,
    pointRadius: 0,
    pointHitRadius: 12,
  }));
}

/** Show either a chart body or its empty block, never both. */
function toggleEmpty(bodyEl, emptyEl, isEmpty) {
  if (bodyEl) bodyEl.classList.toggle("is-hidden", isEmpty);
  if (emptyEl) emptyEl.classList.toggle("is-hidden", !isEmpty);
}

/**
 * Render the value-over-time line chart and its benchmark note.
 *
 * The axis spans `range_start … range_end` from the payload, never the first and
 * last entry of `series.dates`: a position that only started mid-period must not
 * shrink the axis, and the period arithmetic stays on the backend.
 */
function renderValueChart(payload) {
  const canvas = document.querySelector('[data-el="portfolio-chart"]');
  const note = document.querySelector('[data-el="portfolio-chart-note"]');
  if (!canvas) return;

  if (state.portfolioChart) state.portfolioChart.destroy();
  state.portfolioChart = null;

  const { series } = payload;
  const hasBenchmark = series.benchmark.length > 0;
  if (note)
    note.textContent = benchmarkNoteText(
      payload.benchmark_source,
      payload.benchmark_updated_at,
    );

  const legendItem = document.querySelector(
    '[data-el="portfolio-legend-benchmark"]',
  );
  if (legendItem) legendItem.classList.toggle("is-hidden", !hasBenchmark);

  const isEmpty = series.dates.length === 0;
  toggleEmpty(
    canvas.parentElement,
    document.querySelector('[data-el="portfolio-chart-empty"]'),
    isEmpty,
  );
  if (isEmpty) return;

  const min = isoToMs(payload.range_start ?? series.dates[0]);
  const max = isoToMs(payload.range_end ?? series.dates.at(-1));
  const mobile = mobileViewport.matches;
  const tickLimit = mobile ? MAX_AXIS_TICKS_MOBILE : MAX_AXIS_TICKS;
  // Built once: the window is fixed for this chart, while `afterBuildTicks`
  // fires again on every resize.
  const { values: tickValues, daily } = axisTicks(min, max, tickLimit);

  state.portfolioChart = new Chart(canvas, {
    type: "line",
    data: { datasets: valueDatasets(series) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP_STYLE,
          callbacks: {
            title: (items) => formatTooltipDate(items[0].parsed.x),
            label: (context) =>
              `${context.dataset.label}: €${formatAmount(context.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min,
          max,
          grid: { color: GRID_COLOR },
          border: { display: false },
          afterBuildTicks: (scale) => {
            scale.ticks = tickValues.map((value) => ({ value }));
          },
          ticks: {
            color: TICK_COLOR,
            font: MONO_FONT,
            autoSkip: false,
            maxRotation: 0,
            callback: (value) =>
              daily ? formatDayTick(value) : formatTick(value),
          },
        },
        y: {
          grid: { color: GRID_COLOR },
          border: { display: false },
          ticks: {
            // Dropped on a phone, as in the design's mock: the labels would take
            // a third of the plot and squeeze the month labels into each other.
            display: !mobile,
            color: TICK_COLOR,
            font: MONO_FONT,
            maxTicksLimit: 5,
            callback: (value) => `€${axisFormat.format(value)}`,
          },
        },
      },
    },
  });
}

/**
 * Render the allocation doughnut and its hand-built legend.
 *
 * `share_pct` is used as delivered: the server already dropped closed and
 * zero-value positions and pooled everything past the top five, so recomputing
 * percentages here would disagree with the aggregated slice.
 */
function renderAllocationChart(allocation) {
  const canvas = document.querySelector(
    '[data-el="portfolio-allocation-chart"]',
  );
  const legend = document.querySelector(
    '[data-el="portfolio-allocation-legend"]',
  );
  if (!canvas || !legend) return;

  if (state.allocationChart) state.allocationChart.destroy();
  state.allocationChart = null;

  legend.innerHTML = allocationLegendHtml(allocation);
  // Paint the swatches via the CSSOM (not a style attribute) so a strict
  // style-src CSP does not block them; order matches the chart data.
  legend.querySelectorAll(".portfolio-alloc-color").forEach((swatch, index) => {
    swatch.style.background = chartColors[index % chartColors.length];
  });

  const isEmpty = allocation.length === 0;
  canvas.parentElement.classList.toggle("is-hidden", isEmpty);
  if (isEmpty) return;

  state.allocationChart = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: allocation.map((slice) => slice.label),
      datasets: [
        {
          data: allocation.map((slice) => slice.value_eur),
          backgroundColor: allocation.map(
            (_, index) => chartColors[index % chartColors.length],
          ),
          borderWidth: 0,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // 17px of ring on a 132px donut.
      cutout: "74%",
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP_STYLE,
          callbacks: {
            label: (context) =>
              `€${formatAmount(context.raw)} (${allocation[
                context.dataIndex
              ].share_pct.toFixed(1)}%)`,
          },
        },
      },
    },
  });
}

/**
 * Render the biggest-changes bars — plain DOM, deliberately no chart library for
 * four rows of a single value each.
 */
function renderBiggestChanges(changes) {
  const container = document.querySelector('[data-el="portfolio-changes"]');
  if (!container) return;

  container.innerHTML = biggestChangesHtml(changes);
  // Data-driven width, so it goes through the CSSOM like the swatches above.
  container.querySelectorAll(".portfolio-bar-fill").forEach((fill) => {
    fill.style.width = `${Number(fill.dataset.share) * 100}%`;
  });
}

/** Draw all three portfolio visualisations from one payload. */
export function renderPortfolioCharts(payload) {
  renderValueChart(payload);
  renderAllocationChart(payload.allocation);
  renderBiggestChanges(payload.changes);
}
