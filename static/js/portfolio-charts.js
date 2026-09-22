/**
 * Portfolio visualisations: the value-over-time line, the allocation doughnut
 * and the biggest-changes bars.
 *
 * The markup strings come from `portfolio-render.js`; this module owns the DOM,
 * the vendored global `Chart` and the CSSOM writes a strict `style-src` CSP
 * forces on anything data-driven. Every chart is destroyed before it is
 * recreated, because a period or depot switch re-enters this path.
 */

import { state, chartColors, positionLineColors } from "./state.js";
import { lineColor } from "./portfolio-line-colors.js";
import { mobileViewport, withEuro } from "./dom.js";
import {
  allocationLegendHtml,
  benchmarkDisplayName,
  benchmarkNoteText,
  biggestChangesHtml,
  formatEuro,
  seriesLegendHtml,
} from "./portfolio-render.js";
import { POSITIONS_ALL } from "./portfolio-positions-filter.js";
import { refreshTruncation } from "./truncate.js";

// Whole euros on the axis: the two decimals the cards and rows carry are noise
// at tick size, and the design leaves the y labels deliberately quiet.
const axisFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

// How the axis writes every tick: "20k €" instead of "20,000 €" keeps the labels
// off the plot. What it falls back to when ticks collide: `AXIS_FORMATS` below.
const compactAxisFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

// The last rung: on an almost flat axis the ticks sit less than a euro apart,
// where whole euros would collide just as the compact form does.
const centAxisFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Tried in order, coarsest first.
const AXIS_FORMATS = [compactAxisFormat, axisFormat, centAxisFormat];

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

/**
 * Label a run of y-axis ticks compactly (`20k €`), or step down until they differ.
 *
 * Compacting rounds, and the scale sits tight around the data — over a narrow
 * window `1,250` and `1,290` both land on `1.3k`. The run therefore steps down
 * the `AXIS_FORMATS` ladder — compact, whole euros, cents — to the first spelling
 * that separates every tick, the invariant `axisTicks()` keeps on the x-axis.
 * Uniqueness belongs to the axis, not to a single tick, which is why this takes
 * them all and switches the whole run at once: two spellings on one axis would
 * read as two scales. Only ticks less than a cent apart run out of ladder.
 *
 * `Intl` renders an uppercase `K`/`M`; the axis type is deliberately quiet, so
 * the suffix is lowered to sit closer to the digits. On a spelled-out amount
 * there is no letter to lower.
 */
export function valueAxisLabels(values) {
  const runs = AXIS_FORMATS.map((format) =>
    values.map((value) => withEuro(format.format(value).toLowerCase())),
  );
  return runs.find((run) => new Set(run).size === run.length) ?? runs.at(-1);
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

/**
 * Keep exactly `limit` values, evenly spaced, with the first and last kept.
 *
 * A whole-number stride would round up and spend less than the budget — seven
 * month starts under a limit of six would step by two and label only four.
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
 * The lines a per-position selection draws, or `[]` while nothing is picked out.
 *
 * A position keeps the color its slot in `colors` gives it, not one derived from
 * where it sits: unchecking one line must not repaint the others, and no two
 * lines may share a color (`portfolio-line-colors.js` owns both rules). A
 * position without a slot is skipped rather than drawn in a repeated color.
 *
 * Value lines only. The invested line belongs to the aggregate view: tying it
 * to the number of checked boxes would let the chart change meaning without
 * saying so.
 *
 * @param {Map<number, number>} colors the palette slot per position id
 * @returns {{label: string, values: number[], color: string}[]}
 */
export function positionLines(series, selection, colors) {
  if (selection === POSITIONS_ALL || !Array.isArray(selection)) return [];

  const chosen = new Set(selection);
  const entries = series.positions ?? [];
  const lines = [];
  entries.forEach((entry) => {
    if (!chosen.has(entry.id)) return;
    const color = lineColor(colors, entry.id);
    if (!color) return;
    lines.push({ label: entry.name, values: entry.values, color });
  });

  return lines;
}

/**
 * Build the line datasets: the aggregate three, or one per selected position.
 *
 * The benchmark is appended only when it has values: the server rebases it onto
 * the same grid or returns nothing at all, so the third line is either fully
 * aligned or absent — never partially. A selection drops it entirely, because
 * it is rebased onto the whole portfolio's opening value and would sit at the
 * wrong scale against a subset of it.
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

/** The datasets for a per-position selection. */
function selectionDatasets(series, lines) {
  return lines.map((line) => ({
    label: line.label,
    data: seriesPoints(series.dates, line.values),
    borderColor: line.color,
    borderWidth: 2.5,
  }));
}

/** The datasets for the whole portfolio: value, invested and the benchmark. */
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

/**
 * Show the legend matching what is drawn: the fixed aggregate one, or a swatch
 * per selected line.
 *
 * The dynamic swatches are painted through the CSSOM rather than a style
 * attribute, for the same CSP reason as the allocation ones.
 */
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
  // An empty title would still open a blank tooltip, hence the removal.
  if (benchmarkName) benchmarkItem.title = benchmarkName;
  else benchmarkItem.removeAttribute("title");
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
 * shrink the axis, and the period arithmetic stays on the backend. It is also
 * why a position selection never narrows the axis: it changes the lines, not
 * the window they are read against.
 */
function renderValueChart(payload) {
  const canvas = document.querySelector('[data-el="portfolio-chart"]');
  const note = document.querySelector('[data-el="portfolio-chart-note"]');
  if (!canvas) return;

  if (state.portfolioChart) state.portfolioChart.destroy();
  state.portfolioChart = null;

  const { series } = payload;
  const lines = positionLines(
    series,
    state.portfolioPositions,
    positionLineColors,
  );
  // A selection drops the benchmark, so the note about it goes with it.
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
  // Built once: the window is fixed for this chart, while `afterBuildTicks`
  // fires again on every resize.
  const { values: tickValues, daily } = axisTicks(min, max, tickLimit);

  state.portfolioChart = new Chart(canvas, {
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
          ticks: {
            color: TICK_COLOR,
            font: MONO_FONT,
            maxTicksLimit: 5,
            callback: (value, index, ticks) =>
              valueAxisLabels(ticks.map((tick) => tick.value))[index],
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
  // Re-cut here rather than once per payload: a position toggle and a
  // breakpoint change both re-enter this path and rewrite the container.
  refreshTruncation(legend);

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
              `${formatEuro(context.raw)} (${allocation[
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
  refreshTruncation(container);
}

/** Draw all three portfolio visualisations from one payload. */
export function renderPortfolioCharts(payload) {
  renderValueChart(payload);
  renderAllocationChart(payload.allocation);
  renderBiggestChanges(payload.changes);
}
