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
  benchmarkNoteText,
  biggestChangesHtml,
} from "../../static/js/portfolio-render.js";
import {
  axisTicks,
  renderPortfolioCharts,
} from "../../static/js/portfolio-charts.js";
import { state, chartColors } from "../../static/js/state.js";

const markup = `
  <div data-el="portfolio-chart-card">
    <span data-el="portfolio-legend-benchmark"></span>
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
  },
  benchmark_source: "feed",
  benchmark_updated_at: "2026-09-06",
});

// Every instance the stub built, so a re-render can be checked for destroying
// the one it replaces.
let instances = [];

const lineConfig = () => globalThis.Chart.mock.calls[0][1];
const noteText = () =>
  document.querySelector('[data-el="portfolio-chart-note"]').textContent;
const barFills = () =>
  Array.from(document.querySelectorAll(".portfolio-bar-fill"));

beforeEach(() => {
  document.body.innerHTML = markup;
  state.portfolioChart = null;
  state.allocationChart = null;
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

  it("falls back to a message when nothing moved", () => {
    expect(biggestChangesHtml({ gainers: [], losers: [] })).toContain(
      "portfolio-card-empty",
    );
  });
});

describe("benchmarkNoteText", () => {
  it("names the feed and the day it last delivered", () => {
    expect(benchmarkNoteText("feed", "2026-09-06")).toBe(
      "Benchmark from index feed · last updated 06.09.2026",
    );
  });

  it("names the substitute, not the failure, when the feed is unavailable", () => {
    expect(benchmarkNoteText("fallback", "2026-09-06")).toBe(
      "Benchmark: own MSCI World SRI (index feed unavailable)",
    );
  });

  it("says nothing at all when there is no third line", () => {
    expect(benchmarkNoteText(null, null)).toBe("");
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

  it("draws the benchmark as a third line and shows its legend item", () => {
    renderPortfolioCharts(chartPayload());
    const legend = document.querySelector(
      '[data-el="portfolio-legend-benchmark"]',
    );

    expect(lineConfig().data.datasets).toHaveLength(3);
    expect(legend.classList.contains("is-hidden")).toBe(false);
  });

  it("drops the third line and its legend item when the series is empty", () => {
    const payload = chartPayload();
    payload.series.benchmark = [];
    payload.benchmark_source = null;
    payload.benchmark_updated_at = null;

    renderPortfolioCharts(payload);
    const legend = document.querySelector(
      '[data-el="portfolio-legend-benchmark"]',
    );

    expect(lineConfig().data.datasets).toHaveLength(2);
    expect(legend.classList.contains("is-hidden")).toBe(true);
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
