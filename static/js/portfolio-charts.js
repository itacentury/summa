/**
 * Portfolio charts: value over time, allocation doughnut, biggest changes.
 * Data-driven styles go through the CSSOM because a strict `style-src` CSP
 * blocks style attributes. Every switch re-enters here, so charts are destroyed first.
 */

import { portfolioState, positionLineColors } from "./state.js";
import { lineColor } from "./portfolio-line-colors.js";
import { chartColors, mobileViewport, withEuro } from "./dom.js";
import {
  allocationLegendHtml,
  benchmarkDisplayName,
  benchmarkNoteText,
  biggestChangesHtml,
  seriesLegendHtml,
} from "./portfolio-render.js";
import { formatEuro } from "./portfolio-format.js";
import { POSITIONS_ALL } from "./portfolio-positions-filter.js";
import { refreshTruncation } from "./truncate.js";

// Whole euros: cents are noise at tick size.
const axisFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

// "20k €" instead of "20,000 €" keeps the labels off the plot.
const compactAxisFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

// For an almost flat axis, where ticks sit less than a euro apart.
const centAxisFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Tried in order, coarsest first.
const AXIS_FORMATS = [compactAxisFormat, axisFormat, centAxisFormat];

// Canvas cannot resolve CSS custom properties, so these are the literal hex
// behind --accent, --chart-4 and --chart-7.
const PORTFOLIO_COLOR = "#c98d6b";
const INVESTED_COLOR = "#b5a184";
const BENCHMARK_COLOR = "#a3c2c2";

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
  boxPadding: 6,
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

// `autoSkip` cannot thin the ticks because they are placed by hand.
const MAX_AXIS_TICKS = 6;
const MAX_AXIS_TICKS_MOBILE = 3;

// UTC has no DST, so a week is always exactly seven fixed-length days.
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Convert an ISO day to epoch milliseconds at UTC midnight. Built from the parts
 * rather than parsed, so the local timezone cannot shift the day.
 */
function isoToMs(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Label y-axis ticks with the coarsest `AXIS_FORMATS` spelling that keeps every
 * tick distinct; the whole run switches at once so one axis never mixes scales.
 * The `K`/`M` suffix is lowercased to keep the labels quiet.
 */
export function valueAxisLabels(values) {
  let run = [];
  for (const format of AXIS_FORMATS) {
    run = values.map((value) => withEuro(format.format(value).toLowerCase()));
    if (new Set(run).size === run.length) return run;
  }
  return run;
}

/** Format an axis tick as `Oct 25`. */
function formatTick(ms) {
  const date = new Date(ms);
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${TICK_MONTHS[date.getUTCMonth()]} ${year}`;
}

/** Format an axis tick as `02 Sep`, for a sub-month window. */
function formatDayTick(ms) {
  const date = new Date(ms);
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${day} ${TICK_MONTHS[date.getUTCMonth()]}`;
}

/** Format a tooltip title as `06.09.2026`. */
function formatTooltipDate(ms) {
  const date = new Date(ms);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

function nextMonthStart(ms) {
  const at = new Date(ms);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/** The month starts inside the window, ascending. */
function monthTicks(minMs, maxMs) {
  const first = new Date(minMs);
  // The window's own month counts when it opens on the 1st ("ytd" in January).
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

/**
 * Keep exactly `limit` evenly spaced values, first and last included. A
 * whole-number stride would round up and label fewer ticks than the budget.
 */
function thin(values, limit) {
  if (values.length <= limit) return values;
  if (limit < 2) return [values[0]];
  const step = (values.length - 1) / (limit - 1);
  return Array.from(
    { length: limit },
    (_, index) => values[Math.round(index * step)],
  );
}

/**
 * Pick the x-axis ticks: month starts, else Mondays, else the window ends.
 * A linear scale would place them mid-month and produce duplicate labels.
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

function seriesPoints(dates, values) {
  return dates.map((date, index) => ({ x: isoToMs(date), y: values[index] }));
}

/**
 * The lines a per-position selection draws, or `[]` for "all". Colors come from
 * the stable slots in `slots`; a position without a slot is skipped rather than
 * drawn in a repeated color. The invested line stays aggregate-only.
 *
 * @param {Map<number, number>} slots the palette slot per position id
 * @param {string[]} palette the chart colours, as `chartColors()` returns them
 * @returns {{label: string, values: number[], color: string}[]}
 */
export function positionLines(series, selection, slots, palette) {
  if (selection === POSITIONS_ALL || !Array.isArray(selection)) return [];

  const chosen = new Set(selection);
  const entries = series.positions ?? [];
  const lines = [];
  entries.forEach((entry) => {
    if (!chosen.has(entry.id)) return;
    const color = lineColor(slots, entry.id, palette);
    if (!color) return;
    lines.push({ label: entry.name, values: entry.values, color });
  });

  return lines;
}

/**
 * Build the line datasets: the aggregate three, or one per selected position.
 * A selection drops the benchmark, which is rebased onto the whole portfolio.
 */
function valueDatasets(series, lines) {
  const datasets =
    lines.length > 0
      ? selectionDatasets(series, lines)
      : aggregateDatasets(series);

  return datasets.map((dataset) => ({
    ...dataset,
    tension: 0,
    fill: false,
    pointRadius: 0,
    pointHitRadius: 12,
  }));
}

function selectionDatasets(series, lines) {
  return lines.map((line) => ({
    label: line.label,
    data: seriesPoints(series.dates, line.values),
    borderColor: line.color,
    borderWidth: 2.5,
  }));
}

/** Value, invested and — when the server sent one — the benchmark. */
function aggregateDatasets(series) {
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
      label: "Benchmark",
      data: seriesPoints(series.dates, series.benchmark),
      borderColor: BENCHMARK_COLOR,
      borderWidth: 2,
    });
  }
  return datasets;
}

/** Show the fixed aggregate legend, or a CSSOM-painted swatch per selected line. */
function syncChartLegend(lines, hasBenchmark, benchmarkName) {
  const fixed = document.querySelector('[data-el="portfolio-legend-static"]');
  const dynamic = document.querySelector('[data-el="portfolio-legend-series"]');
  const perPosition = lines.length > 0;

  if (fixed) fixed.classList.toggle("is-hidden", perPosition);
  if (dynamic) {
    dynamic.classList.toggle("is-hidden", !perPosition);
    dynamic.innerHTML = perPosition ? seriesLegendHtml(lines) : "";
    dynamic.querySelectorAll(".portfolio-legend-bar").forEach((bar, index) => {
      bar.style.background = lines[index].color;
    });
  }

  const benchmarkItem = document.querySelector(
    '[data-el="portfolio-legend-benchmark"]',
  );
  if (!benchmarkItem) return;
  benchmarkItem.classList.toggle("is-hidden", !hasBenchmark);
  // An empty title would still open a blank tooltip.
  if (benchmarkName) benchmarkItem.title = benchmarkName;
  else benchmarkItem.removeAttribute("title");
}

function toggleEmpty(bodyEl, emptyEl, isEmpty) {
  if (bodyEl) bodyEl.classList.toggle("is-hidden", isEmpty);
  if (emptyEl) emptyEl.classList.toggle("is-hidden", !isEmpty);
}

/**
 * Render the value-over-time chart. The axis spans the payload's `range_start …
 * range_end`, not the data, so a late-starting position or a selection never
 * narrows the window.
 */
function renderValueChart(payload) {
  const canvas = document.querySelector('[data-el="portfolio-chart"]');
  const note = document.querySelector('[data-el="portfolio-chart-note"]');
  if (!canvas) return;

  if (portfolioState.portfolioChart) portfolioState.portfolioChart.destroy();
  portfolioState.portfolioChart = null;

  const { series } = payload;
  const lines = positionLines(
    series,
    portfolioState.portfolioPositions,
    positionLineColors,
    chartColors(),
  );
  const hasBenchmark = series.benchmark.length > 0 && lines.length === 0;
  if (note)
    note.textContent = hasBenchmark
      ? benchmarkNoteText(
          payload.benchmark_source,
          payload.benchmark_updated_at,
          payload.benchmark_name,
        )
      : "";

  syncChartLegend(
    lines,
    hasBenchmark,
    hasBenchmark
      ? benchmarkDisplayName(payload.benchmark_source, payload.benchmark_name)
      : "",
  );

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
  // Built once: `afterBuildTicks` fires again on every resize.
  const { values: tickValues, daily } = axisTicks(min, max, tickLimit);
  let valueLabels = [];

  portfolioState.portfolioChart = new Chart(canvas, {
    type: "line",
    data: { datasets: valueDatasets(series, lines) },
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
              `${context.dataset.label}: ${formatEuro(context.parsed.y)}`,
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
          // One spelling for the whole run, so labels are built here rather
          // than in the per-tick callback.
          afterBuildTicks: (scale) => {
            valueLabels = valueAxisLabels(
              scale.ticks.map((tick) => tick.value),
            );
          },
          ticks: {
            color: TICK_COLOR,
            font: MONO_FONT,
            maxTicksLimit: 5,
            callback: (value, index) => valueLabels[index],
          },
        },
      },
    },
  });
}

/**
 * Render the allocation doughnut and its legend. `share_pct` is used as sent:
 * recomputing it would disagree with the server's pooled slice.
 */
function renderAllocationChart(allocation) {
  const canvas = document.querySelector(
    '[data-el="portfolio-allocation-chart"]',
  );
  const legend = document.querySelector(
    '[data-el="portfolio-allocation-legend"]',
  );
  if (!canvas || !legend) return;

  if (portfolioState.allocationChart) portfolioState.allocationChart.destroy();
  portfolioState.allocationChart = null;

  legend.innerHTML = allocationLegendHtml(allocation);
  const colors = chartColors();
  // CSSOM, not a style attribute, for the strict style-src CSP; order matches the data.
  legend.querySelectorAll(".portfolio-alloc-color").forEach((swatch, index) => {
    swatch.style.background = colors[index % colors.length];
  });
  refreshTruncation(legend);

  const isEmpty = allocation.length === 0;
  canvas.parentElement.classList.toggle("is-hidden", isEmpty);
  if (isEmpty) return;

  portfolioState.allocationChart = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: allocation.map((slice) => slice.label),
      datasets: [
        {
          data: allocation.map((slice) => slice.value_eur),
          backgroundColor: allocation.map(
            (_, index) => colors[index % colors.length],
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
              `${formatEuro(context.raw)} (${allocation[
                context.dataIndex
              ].share_pct.toFixed(1)}%)`,
          },
        },
      },
    },
  });
}

/** Render the biggest-changes bars as plain DOM; four rows need no chart library. */
function renderBiggestChanges(changes) {
  const container = document.querySelector('[data-el="portfolio-changes"]');
  if (!container) return;

  container.innerHTML = biggestChangesHtml(changes);
  // Data-driven width, so it goes through the CSSOM too.
  container.querySelectorAll(".portfolio-bar-fill").forEach((fill) => {
    fill.style.width = `${Number(fill.dataset.share) * 100}%`;
  });
  refreshTruncation(container);
}

export function renderPortfolioCharts(payload) {
  renderValueChart(payload);
  renderAllocationChart(payload.allocation);
  renderBiggestChanges(payload.changes);
}
