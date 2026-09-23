/**
 * Portfolio charts: the pure markup builders and the Chart.js wiring.
 *
 * The rules worth pinning here are the ones a payload alone cannot enforce: the
 * axis comes from the period window rather than from the data, the benchmark is
 * all-or-nothing, and every data-driven colour or width is painted through the
 * CSSOM so a strict style-src CSP cannot blank it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  allocationLegendHtml,
  benchmarkDisplayName,
  benchmarkNoteText,
  biggestChangesHtml,
} from "../../static/js/portfolio-render.js";
// dom.js evaluates mobileViewport (a MediaQueryList) at import time; swap in a
// plain object so a test can flip the breakpoint without touching matchMedia.
const { mobileViewport } = vi.hoisted(() => ({
  mobileViewport: { matches: false },
}));

vi.mock("../../static/js/dom.js", async (importOriginal) => ({
  ...(await importOriginal()),
  mobileViewport,
}));

import {
  axisTicks,
  positionLines,
  renderPortfolioCharts,
  valueAxisLabels,
} from "../../static/js/portfolio-charts.js";
import {
  state,
  chartColors,
  positionLineColors,
} from "../../static/js/state.js";
import { assignLineColors } from "../../static/js/portfolio-line-colors.js";

const markup = `
  <div data-el="portfolio-chart-card">
    <div data-el="portfolio-legend-static">
      <span data-el="portfolio-legend-benchmark"></span>
    </div>
    <div class="is-hidden" data-el="portfolio-legend-series"></div>
    <div class="portfolio-chart-body"><canvas data-el="portfolio-chart"></canvas></div>
    <div class="is-hidden" data-el="portfolio-chart-empty"></div>
    <div data-el="portfolio-chart-note"></div>
  </div>
  <div data-el="portfolio-bottom">
    <div class="portfolio-donut"><canvas data-el="portfolio-allocation-chart"></canvas></div>
    <div data-el="portfolio-allocation-legend"></div>
    <div data-el="portfolio-changes"></div>
  </div>
`;

const chartPayload = () => ({
  range: "1y",
  range_start: "2025-09-14",
  range_end: "2026-09-14",
  allocation: [
    {
      label: "Deka Industrie 0",
      value_eur: 4925.73,
      share_pct: 73.2,
      aggregated_count: 0,
    },
    {
      label: "MSCI World SRI",
      value_eur: 1389.27,
      share_pct: 20.7,
      aggregated_count: 0,
    },
  ],
  changes: {
    gainers: [{ position_id: 12, name: "FTSE All-World", week_delta: 20.0 }],
    losers: [{ position_id: 21, name: "Deka Industrie 0", week_delta: -40.0 }],
  },
  series: {
    dates: ["2026-08-30", "2026-09-06"],
    portfolio: [6743.0, 6727.42],
    invested: [6350.0, 6350.0],
    benchmark: [6743.0, 6751.4],
    positions: [
      {
        id: 21,
        name: "Deka Industrie 0",
        values: [4940.0, 4925.73],
      },
      {
        id: 12,
        name: "FTSE All-World",
        values: [1803.0, 1801.69],
      },
    ],
  },
  benchmark_source: "feed",
  benchmark_updated_at: "2026-09-06",
  benchmark_name: "EUNL.DE",
});

// Every instance the stub built, so a re-render can be checked for destroying
// the one it replaces.
let instances = [];

const lineConfig = () => globalThis.Chart.mock.calls[0][1];
const noteText = () =>
  document.querySelector('[data-el="portfolio-chart-note"]').textContent;
const barFills = () =>
  Array.from(document.querySelectorAll(".portfolio-bar-fill"));

/**
 * Select `ids` the way the view does: the state, plus the palette slots the
 * selection hands out. Chained calls carry the previous assignment, which is
 * what makes a deselection observable.
 */
const select = (ids) => {
  state.portfolioPositions = ids;
  const next = assignLineColors(positionLineColors, ids);
  positionLineColors.clear();
  next.forEach((slot, id) => positionLineColors.set(id, slot));
  return positionLineColors;
};

beforeEach(() => {
  document.body.innerHTML = markup;
  mobileViewport.matches = false;
  state.portfolioChart = null;
  state.allocationChart = null;
  state.portfolioPositions = "all";
  positionLineColors.clear();
  instances = [];
  vi.clearAllMocks();
  // happy-dom hands a canvas no 2D context, so the real Chart.js would throw.
  // A function declaration, not an arrow: the charts call it with `new`.
  globalThis.Chart = vi.fn(function ChartStub(canvas, config) {
    this.config = config;
    this.destroy = vi.fn();
    instances.push(this);
  });
});

describe("allocationLegendHtml", () => {
  it("renders the server's shares verbatim rather than recomputing them", () => {
    const html = allocationLegendHtml(chartPayload().allocation);

    expect(html).toContain("73.2 %");
    expect(html).toContain("20.7 %");
    expect(html).not.toContain("is-aggregated");
  });

  it("mutes the pooled slice, which names a group and not a position", () => {
    const html = allocationLegendHtml([
      { label: "ASML", value_eur: 100, share_pct: 60.0, aggregated_count: 0 },
      { label: "4 more", value_eur: 66, share_pct: 40.0, aggregated_count: 4 },
    ]);

    expect(html).toContain("is-aggregated");
    expect(html).toContain("4 more");
  });

  it("escapes a position name rather than trusting it as markup", () => {
    const html = allocationLegendHtml([
      {
        label: "<img src=x>",
        value_eur: 1,
        share_pct: 100.0,
        aggregated_count: 0,
      },
    ]);

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("hands the label to the middle-ellipsis carrier, not the CSS one", () => {
    const html = allocationLegendHtml(chartPayload().allocation);

    expect(html).toContain('<span data-full="Deka Industrie 0"');
  });

  it("falls back to a message when nothing is held", () => {
    expect(allocationLegendHtml([])).toContain("portfolio-card-empty");
  });
});

describe("biggestChangesHtml", () => {
  it("scales both halves against the largest absolute move, not each own", () => {
    document.body.innerHTML = biggestChangesHtml(chartPayload().changes);
    const shares = barFills().map((fill) => Number(fill.dataset.share));

    // The 20 gainer measured against the 40 loser, which sets the scale.
    expect(shares).toEqual([0.5, 1]);
  });

  it("separates gainers from losers and tones each side", () => {
    document.body.innerHTML = biggestChangesHtml(chartPayload().changes);

    expect(document.querySelectorAll(".portfolio-change-divider")).toHaveLength(
      1,
    );
    expect(barFills()[0].classList.contains("is-gain")).toBe(true);
    expect(barFills()[1].classList.contains("is-loss")).toBe(true);
  });

  it("omits the divider when only one side has movers", () => {
    document.body.innerHTML = biggestChangesHtml({
      gainers: [{ position_id: 1, name: "ASML", week_delta: 4 }],
      losers: [],
    });

    expect(document.querySelectorAll(".portfolio-change-divider")).toHaveLength(
      0,
    );
  });

  it("hands each mover's name to the middle-ellipsis carrier", () => {
    document.body.innerHTML = biggestChangesHtml(chartPayload().changes);
    const names = Array.from(
      document.querySelectorAll(".portfolio-change-name > [data-full]"),
    ).map((carrier) => carrier.dataset.full);

    // The card that motivated the cut: two holdings compared one under the
    // other, where an end ellipsis drops exactly what tells them apart.
    expect(names).toEqual(["FTSE All-World", "Deka Industrie 0"]);
  });

  it("falls back to a message when nothing moved", () => {
    expect(biggestChangesHtml({ gainers: [], losers: [] })).toContain(
      "portfolio-card-empty",
    );
  });
});

describe("benchmarkDisplayName", () => {
  it("spells out a ticker the feed job is configured for", () => {
    expect(benchmarkDisplayName("feed", "EUNL.DE")).toBe(
      "MSCI World (iShares Core)",
    );
  });

  it("shows an unlisted ticker as itself", () => {
    expect(benchmarkDisplayName("feed", "URTH")).toBe("URTH");
  });

  it("takes the fallback's name from the position, unmapped", () => {
    expect(benchmarkDisplayName("fallback", "MSCI World SRI")).toBe(
      "MSCI World SRI",
    );
  });

  it("has nothing to name without a source or a name", () => {
    expect(benchmarkDisplayName(null, null)).toBe("");
    expect(benchmarkDisplayName("feed", null)).toBe("");
  });
});

describe("benchmarkNoteText", () => {
  it("names the index, the feed and the day it last delivered", () => {
    expect(benchmarkNoteText("feed", "2026-09-06", "EUNL.DE")).toBe(
      "Benchmark: MSCI World (iShares Core) · index feed, last updated 06.09.2026",
    );
  });

  it("names the substitute position, not the failure, when the feed is unavailable", () => {
    expect(benchmarkNoteText("fallback", "2026-09-06", "MSCI World SRI")).toBe(
      "Benchmark: own position MSCI World SRI (index feed unavailable)",
    );
  });

  it("still reads as a sentence when the payload carries no name", () => {
    expect(benchmarkNoteText("feed", "2026-09-06", null)).toBe(
      "Benchmark: index feed, last updated 06.09.2026",
    );
    expect(benchmarkNoteText("fallback", "2026-09-06", null)).toBe(
      "Benchmark: an own position (index feed unavailable)",
    );
  });

  it("says nothing at all when there is no third line", () => {
    expect(benchmarkNoteText(null, null, null)).toBe("");
  });
});

describe("axisTicks", () => {
  const iso = (values) =>
    values.map((ms) => new Date(ms).toISOString().slice(0, 10));

  it("keeps the opening month of a window that starts on the 1st", () => {
    // What "ytd" hands the chart every January.
    const { values } = axisTicks(
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 8, 14),
      6,
    );

    expect(iso(values)[0]).toBe("2026-01-01");
  });

  it("still opens on the next month start when the window starts mid-month", () => {
    const { values, daily } = axisTicks(
      Date.UTC(2025, 8, 14),
      Date.UTC(2026, 8, 14),
      6,
    );

    expect(iso(values)[0]).toBe("2025-10-01");
    expect(daily).toBe(false);
  });

  it("places every tick on a month start inside the window, ascending", () => {
    const min = Date.UTC(2025, 8, 14);
    const max = Date.UTC(2026, 8, 14);
    const { values } = axisTicks(min, max, 12);

    expect(iso(values).every((date) => date.endsWith("-01"))).toBe(true);
    expect(values.every((ms) => ms >= min && ms <= max)).toBe(true);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("falls back to week starts when no month boundary fits in the window", () => {
    // "max" over a few weeks of history: 2026-09-02 is a Wednesday.
    const { values, daily } = axisTicks(
      Date.UTC(2026, 8, 2),
      Date.UTC(2026, 8, 29),
      6,
    );

    expect(iso(values)).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ]);
    expect(daily).toBe(true);
  });

  it("falls back to the window ends when not even two Mondays fit", () => {
    // "ytd" in the first days of January — the axis used to render bare here.
    const { values, daily } = axisTicks(
      Date.UTC(2026, 0, 2),
      Date.UTC(2026, 0, 6),
      6,
    );

    expect(iso(values)).toEqual(["2026-01-02", "2026-01-06"]);
    expect(daily).toBe(true);
  });

  it("never hands back an empty tick list, which renders the axis bare", () => {
    const windows = [
      [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 3)],
      [Date.UTC(2026, 8, 2), Date.UTC(2026, 8, 3)],
      [Date.UTC(2026, 8, 2), Date.UTC(2026, 8, 2)],
    ];

    windows.forEach(([min, max]) => {
      expect(axisTicks(min, max, 6).values.length).toBeGreaterThan(0);
    });
  });

  it("collapses a single-day window into one tick rather than a duplicate", () => {
    const day = Date.UTC(2026, 8, 2);

    expect(axisTicks(day, day, 6).values).toEqual([day]);
  });

  it("thins the ticks down to the limit the viewport allows", () => {
    const min = Date.UTC(2025, 8, 14);
    const max = Date.UTC(2026, 8, 14);

    expect(axisTicks(min, max, 6).values).toHaveLength(6);
    expect(axisTicks(min, max, 3).values.length).toBeLessThanOrEqual(3);
  });

  it("spends the whole tick budget rather than rounding the stride up", () => {
    const min = Date.UTC(2026, 0, 1);
    const max = Date.UTC(2026, 6, 5);

    const { values } = axisTicks(min, max, 6);

    // Seven month starts fit: a whole-number stride would step by two and label
    // only four of them.
    expect(values).toHaveLength(6);
    expect(values[0]).toBe(Date.UTC(2026, 0, 1));
    expect(values.at(-1)).toBe(Date.UTC(2026, 6, 1));
  });
});

describe("valueAxisLabels", () => {
  const euro = (amount) => `${amount}\u00a0€`;

  it("compacts the amounts, with a lowercase suffix", () => {
    expect(valueAxisLabels([20000, 6500, 1200000])).toEqual([
      euro("20k"),
      euro("6.5k"),
      euro("1.2m"),
    ]);
  });

  it("leaves an amount below a thousand alone — there is nothing to compact", () => {
    expect(valueAxisLabels([500, 750])).toEqual([euro("500"), euro("750")]);
  });

  it("spells the whole run out rather than collapse two ticks onto one label", () => {
    // A single position over a month: compacted, all four would read "1.3k".
    expect(valueAxisLabels([1250, 1270, 1290, 1310])).toEqual([
      euro("1,250"),
      euro("1,270"),
      euro("1,290"),
      euro("1,310"),
    ]);
  });

  it("steps down to cents when whole euros would still collide", () => {
    // An almost flat axis: a single small position over a quiet week.
    expect(valueAxisLabels([1000.2, 1000.4, 1000.6])).toEqual([
      euro("1,000.20"),
      euro("1,000.40"),
      euro("1,000.60"),
    ]);
  });

  it("falls back for the whole run, never per tick", () => {
    // Mixing two spellings on one axis would read as two different scales.
    const labels = valueAxisLabels([54250, 54300, 60000]);

    expect(labels.every((label) => !label.includes("k"))).toBe(true);
  });

  it("never hands back two identical labels, whatever the tick spacing", () => {
    const runs = [
      [20000, 30000, 40000],
      [1250, 1270, 1290, 1310],
      [54250, 54300, 54350],
      [999, 1000, 1001],
      [0, 500, 1000],
      [1000.2, 1000.4, 1000.6],
    ];

    runs.forEach((values) => {
      const labels = valueAxisLabels(values);
      expect(new Set(labels).size).toBe(labels.length);
    });
  });
});

describe("renderPortfolioCharts", () => {
  it("spans the axis over the period window, not the data it happens to hold", () => {
    renderPortfolioCharts(chartPayload());
    const { x } = lineConfig().options.scales;

    expect(x.min).toBe(Date.UTC(2025, 8, 14));
    expect(x.max).toBe(Date.UTC(2026, 8, 14));
    // Would be the axis if the first and last snapshot decided it.
    expect(x.min).not.toBe(Date.UTC(2026, 7, 30));
  });

  it("labels the x-axis through the ticks it places by hand", () => {
    renderPortfolioCharts(chartPayload());
    const { x } = lineConfig().options.scales;
    const scale = { ticks: [] };

    x.afterBuildTicks(scale);
    const labels = scale.ticks.map(({ value }) => x.ticks.callback(value));

    expect(scale.ticks.length).toBeGreaterThan(0);
    expect(labels[0]).toBe("Oct 25");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("compacts the y labels, on every viewport", () => {
    renderPortfolioCharts(chartPayload());
    const { y } = lineConfig().options.scales;
    const ticks = [20000, 30000].map((value) => ({ value }));

    y.afterBuildTicks({ ticks });

    expect(y.ticks.callback(20000, 0)).toBe("20k €");
  });

  it("keeps the y labels on a phone, compacted rather than dropped", () => {
    mobileViewport.matches = true;
    renderPortfolioCharts(chartPayload());
    const { y } = lineConfig().options.scales;
    const ticks = [20000, 30000].map((value) => ({ value }));

    y.afterBuildTicks({ ticks });

    expect(y.ticks.display).not.toBe(false);
    expect(y.ticks.callback(20000, 0)).toBe("20k €");
  });

  it("thins the date labels on a phone, where the compact y labels cost width", () => {
    mobileViewport.matches = true;
    renderPortfolioCharts(chartPayload());
    const { x } = lineConfig().options.scales;
    const scale = { ticks: [] };

    x.afterBuildTicks(scale);

    expect(scale.ticks.length).toBeLessThanOrEqual(3);
  });

  it("draws the benchmark as a third line and shows its legend item", () => {
    renderPortfolioCharts(chartPayload());
    const legend = document.querySelector(
      '[data-el="portfolio-legend-benchmark"]',
    );

    expect(lineConfig().data.datasets).toHaveLength(3);
    expect(legend.classList.contains("is-hidden")).toBe(false);
  });

  it("names the yardstick on the legend item rather than in the line's label", () => {
    renderPortfolioCharts(chartPayload());
    const legend = document.querySelector(
      '[data-el="portfolio-legend-benchmark"]',
    );

    expect(legend.title).toBe("MSCI World (iShares Core)");
  });

  it("drops the third line and its legend item when the series is empty", () => {
    const payload = chartPayload();
    payload.series.benchmark = [];
    payload.benchmark_source = null;
    payload.benchmark_updated_at = null;
    payload.benchmark_name = null;

    renderPortfolioCharts(payload);
    const legend = document.querySelector(
      '[data-el="portfolio-legend-benchmark"]',
    );

    expect(lineConfig().data.datasets).toHaveLength(2);
    expect(legend.classList.contains("is-hidden")).toBe(true);
    // An empty title would still open a blank tooltip on hover.
    expect(legend.hasAttribute("title")).toBe(false);
    expect(noteText()).toBe("");
  });

  it("dashes the invested line so it reads apart from the portfolio one", () => {
    renderPortfolioCharts(chartPayload());
    const [portfolio, invested] = lineConfig().data.datasets;

    expect(portfolio.borderDash).toBeUndefined();
    expect(invested.borderDash).toEqual([5, 5]);
  });

  it("destroys both charts before recreating them on a period switch", () => {
    renderPortfolioCharts(chartPayload());
    const [line, donut] = instances;

    renderPortfolioCharts(chartPayload());

    expect(line.destroy).toHaveBeenCalledTimes(1);
    expect(donut.destroy).toHaveBeenCalledTimes(1);
    expect(globalThis.Chart).toHaveBeenCalledTimes(4);
  });

  it("keeps the card but swaps in the empty block for a period with no snapshots", () => {
    const payload = chartPayload();
    payload.series = { dates: [], portfolio: [], invested: [], benchmark: [] };

    renderPortfolioCharts(payload);
    const body = document.querySelector(".portfolio-chart-body");
    const empty = document.querySelector('[data-el="portfolio-chart-empty"]');

    expect(body.classList.contains("is-hidden")).toBe(true);
    expect(empty.classList.contains("is-hidden")).toBe(false);
    expect(state.portfolioChart).toBeNull();
  });

  it("paints the legend swatches through the CSSOM, in the donut's own order", () => {
    renderPortfolioCharts(chartPayload());
    const swatches = document.querySelectorAll(".portfolio-alloc-color");

    expect(swatches[0].style.background).toBe(chartColors[0]);
    expect(swatches[1].style.background).toBe(chartColors[1]);
  });

  it("paints the bar widths through the CSSOM rather than a style attribute", () => {
    renderPortfolioCharts(chartPayload());

    expect(barFills().map((fill) => fill.style.width)).toEqual(["50%", "100%"]);
  });
});

describe("positionLines", () => {
  it("draws nothing of its own while every position is shown", () => {
    expect(positionLines(chartPayload().series, "all", select("all"))).toEqual(
      [],
    );
  });

  it("keeps a line's colour when another line is unchecked", () => {
    const { series } = chartPayload();
    const both = positionLines(series, [21, 12], select([21, 12]));
    const second = positionLines(series, [12], select([12]));

    expect(both.map((line) => line.color)).toEqual([
      chartColors[0],
      chartColors[1],
    ]);
    // Unchecking the first line must not repaint the one left behind.
    expect(second[0].color).toBe(chartColors[1]);
  });

  it("never draws two lines in the same colour", () => {
    const series = {
      dates: ["2026-09-06"],
      positions: Array.from({ length: chartColors.length }, (_, index) => ({
        id: index + 1,
        name: `Position ${index + 1}`,
        values: [100],
      })),
    };
    const ids = series.positions.map((entry) => entry.id);

    const lines = positionLines(series, ids, select(ids));
    const colors = lines.map((line) => line.color);

    expect(colors).toHaveLength(chartColors.length);
    expect(new Set(colors).size).toBe(chartColors.length);
  });

  it("skips a position the palette has no colour left for", () => {
    const { series } = chartPayload();
    // A selection that never went through the filter's cap: 12 gets no slot.
    const colors = new Map([[21, 0]]);

    const lines = positionLines(series, [21, 12], colors);

    expect(lines.map((line) => line.label)).toEqual(["Deka Industrie 0"]);
  });

  it("keeps the payload's order however the selection was built", () => {
    const lines = positionLines(
      chartPayload().series,
      [12, 21],
      select([12, 21]),
    );

    expect(lines.map((line) => line.label)).toEqual([
      "Deka Industrie 0",
      "FTSE All-World",
    ]);
  });

  it("draws the value line alone, never a second invested one", () => {
    const lines = positionLines(chartPayload().series, [12], select([12]));

    expect(lines.map((line) => line.label)).toEqual(["FTSE All-World"]);
    expect(lines[0].values).toEqual([1803.0, 1801.69]);
  });

  it("ignores an id the payload no longer carries", () => {
    expect(positionLines(chartPayload().series, [999], select([999]))).toEqual(
      [],
    );
  });
});

describe("renderPortfolioCharts with a position selection", () => {
  it("draws one line per selected position instead of the aggregate", () => {
    select([21, 12]);
    renderPortfolioCharts(chartPayload());

    const labels = lineConfig().data.datasets.map((set) => set.label);
    expect(labels).toEqual(["Deka Industrie 0", "FTSE All-World"]);
  });

  it("drops the benchmark, which is rebased onto the whole portfolio", () => {
    select([21, 12]);
    renderPortfolioCharts(chartPayload());
    const benchmark = document.querySelector(
      '[data-el="portfolio-legend-benchmark"]',
    );

    expect(lineConfig().data.datasets).toHaveLength(2);
    expect(benchmark.classList.contains("is-hidden")).toBe(true);
    // The note explains a line that is no longer drawn.
    expect(noteText()).toBe("");
  });

  it("swaps the fixed legend for one swatch per drawn line", () => {
    select([21, 12]);
    renderPortfolioCharts(chartPayload());
    const fixed = document.querySelector('[data-el="portfolio-legend-static"]');
    const dynamic = document.querySelector(
      '[data-el="portfolio-legend-series"]',
    );

    expect(fixed.classList.contains("is-hidden")).toBe(true);
    expect(dynamic.classList.contains("is-hidden")).toBe(false);
    expect(dynamic.textContent).toContain("FTSE All-World");
  });

  it("paints the legend swatches through the CSSOM, in the drawn order", () => {
    select([21, 12]);
    renderPortfolioCharts(chartPayload());
    const bars = document.querySelectorAll(
      '[data-el="portfolio-legend-series"] .portfolio-legend-bar',
    );

    expect(bars[0].style.background).toBe(chartColors[0]);
    expect(bars[1].style.background).toBe(chartColors[1]);
  });

  it("legends a single position with its own color and nothing else", () => {
    select([12]);
    renderPortfolioCharts(chartPayload());
    const bars = document.querySelectorAll(
      '[data-el="portfolio-legend-series"] .portfolio-legend-bar',
    );

    expect(bars).toHaveLength(1);
    expect(bars[0].style.background).toBe(chartColors[0]);
  });

  it("escapes a position name in the legend rather than trusting it", () => {
    const payload = chartPayload();
    payload.series.positions[0].name = "<img src=x>";
    select([21]);

    renderPortfolioCharts(payload);
    const dynamic = document.querySelector(
      '[data-el="portfolio-legend-series"]',
    );

    expect(dynamic.innerHTML).not.toContain("<img");
    expect(dynamic.textContent).toContain("<img src=x>");
  });

  it("returns to the aggregate lines when the selection is cleared", () => {
    select([21]);
    renderPortfolioCharts(chartPayload());
    select("all");
    renderPortfolioCharts(chartPayload());

    // Two charts per render, so the last line chart is the second from the end.
    const config = globalThis.Chart.mock.calls.at(-2)[1];
    const fixed = document.querySelector('[data-el="portfolio-legend-static"]');

    expect(config.data.datasets.map((set) => set.label)).toEqual([
      "Portfolio",
      "Invested",
      "Benchmark",
    ]);
    expect(fixed.classList.contains("is-hidden")).toBe(false);
  });

  it("keeps the axis on the period window, not on the selected position", () => {
    select([12]);
    renderPortfolioCharts(chartPayload());
    const { x } = lineConfig().options.scales;

    expect(x.min).toBe(Date.UTC(2025, 8, 14));
    expect(x.max).toBe(Date.UTC(2026, 8, 14));
  });
});
