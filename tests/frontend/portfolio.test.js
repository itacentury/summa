/**
 * Portfolio view: restoring the persisted preferences and the period switcher.
 *
 * The point of these cases is isolation — the portfolio period and the invoice
 * period are separate state with separate storage keys, and neither view may
 * inherit the other's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadPortfolio,
  restorePortfolioPrefs,
  setupPortfolioListeners,
} from "../../static/js/portfolio.js";
import {
  formatAmount,
  formatDateDots,
  formatPercent,
  formatSigned,
} from "../../static/js/portfolio-render.js";
import {
  state,
  collapsedDepots,
  expandedPositions,
  PAGE_SIZE_STORAGE_KEY,
  PORTFOLIO_DEPOT_STORAGE_KEY,
  PORTFOLIO_POSITIONS_STORAGE_KEY,
  PORTFOLIO_RANGE_STORAGE_KEY,
  PORTFOLIO_MAX_LINES,
  positionLineColors,
} from "../../static/js/state.js";
import { mobileViewport } from "../../static/js/dom.js";
import { openHistoryModal } from "../../static/js/portfolio-history.js";
import { showErrorToast } from "../../static/js/toast.js";
import { showInvoicesView, showPortfolioView } from "../../static/js/views.js";
import { flushUi, jsonResponse } from "./helpers.js";

// A mock factory replaces the whole namespace, so a factory listing only the
// stubbed export breaks the run the moment anything in this graph imports a
// sibling export — spread the original and override just what is stubbed.
vi.mock("../../static/js/api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadInvoicesOnce: vi.fn(),
}));
vi.mock("../../static/js/stats.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadStats: vi.fn(),
}));
vi.mock("../../static/js/drawer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  closeMobileSearch: vi.fn(),
}));
vi.mock("../../static/js/toast.js", async (importOriginal) => ({
  ...(await importOriginal()),
  showErrorToast: vi.fn(),
}));
vi.mock("../../static/js/portfolio-history.js", async (importOriginal) => ({
  ...(await importOriginal()),
  openHistoryModal: vi.fn(),
}));

const markup = `
  <div data-el="topbar-title"></div>
  <nav class="sidebar-nav">
    <button class="nav-item" data-view="invoices"></button>
    <button class="nav-item" data-view="portfolio"></button>
  </nav>
  <div data-el="invoices-view"></div>
  <div class="is-hidden" data-el="stats-view"></div>
  <div class="is-hidden" data-el="portfolio-view">
    <div data-el="portfolio-period">
      <button class="portfolio-period-btn" data-range="3m" aria-pressed="false"></button>
      <button class="portfolio-period-btn" data-range="1y" aria-pressed="true"></button>
      <button class="portfolio-period-btn" data-range="ytd" aria-pressed="false"></button>
      <button class="portfolio-period-btn" data-range="max" aria-pressed="false"></button>
    </div>
  </div>
`;

const activeRange = () =>
  document.querySelector('.portfolio-period-btn[aria-pressed="true"]')?.dataset
    .range;

const clickRange = (range) =>
  document
    .querySelector(`.portfolio-period-btn[data-range="${range}"]`)
    .click();

describe("restorePortfolioPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
    state.portfolioRange = "1y";
    state.depotFilter = "all";
    state.portfolioPositions = "all";
    positionLineColors.clear();
  });

  it("keeps the defaults when nothing is stored", () => {
    restorePortfolioPrefs();

    expect(state.portfolioRange).toBe("1y");
    expect(state.depotFilter).toBe("all");
    expect(state.portfolioPositions).toBe("all");
  });

  it("restores a stored chart selection", () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[12,21]");
    restorePortfolioPrefs();

    expect(state.portfolioPositions).toEqual([12, 21]);
  });

  it("restores a palette slot per selected position", () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[12,21]");
    restorePortfolioPrefs();

    expect([...positionLineColors]).toEqual([
      [12, 0],
      [21, 1],
    ]);
  });

  it("caps a hand-edited selection at the palette's size", () => {
    const ids = Array.from(
      { length: PORTFOLIO_MAX_LINES + 3 },
      (_, i) => i + 1,
    );
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, JSON.stringify(ids));
    restorePortfolioPrefs();

    expect(state.portfolioPositions).toHaveLength(PORTFOLIO_MAX_LINES);
    expect(positionLineColors.size).toBe(PORTFOLIO_MAX_LINES);
  });

  it("ignores a chart selection that is not a list of ids", () => {
    for (const stored of ["{", "{}", "[]", '["12"]', "null", "3"]) {
      state.portfolioPositions = [1];
      localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, stored);
      restorePortfolioPrefs();
      expect(state.portfolioPositions).toBe("all");
    }
  });

  it("restores every allowed period token", () => {
    for (const range of ["3m", "1y", "ytd", "max"]) {
      state.portfolioRange = "1y";
      localStorage.setItem(PORTFOLIO_RANGE_STORAGE_KEY, range);
      restorePortfolioPrefs();
      expect(state.portfolioRange).toBe(range);
    }
  });

  it("ignores an unknown period token", () => {
    localStorage.setItem(PORTFOLIO_RANGE_STORAGE_KEY, "5y");
    restorePortfolioPrefs();

    expect(state.portfolioRange).toBe("1y");
  });

  it("restores a depot id and the all-depots token", () => {
    localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, "7");
    restorePortfolioPrefs();
    expect(state.depotFilter).toBe("7");

    localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, "all");
    restorePortfolioPrefs();
    expect(state.depotFilter).toBe("all");
  });

  it("ignores a malformed depot filter", () => {
    localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, "1 OR 1=1");
    restorePortfolioPrefs();

    expect(state.depotFilter).toBe("all");
  });
});

describe("portfolio period switcher", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    document.body.className = "";
    localStorage.clear();
    state.portfolioRange = "1y";
    state.filterMode = "month";
  });

  it("syncs the active pill to the restored period on wiring", () => {
    state.portfolioRange = "ytd";
    setupPortfolioListeners();

    expect(activeRange()).toBe("ytd");
  });

  it("persists the picked period and moves the active pill", () => {
    setupPortfolioListeners();
    clickRange("3m");

    expect(state.portfolioRange).toBe("3m");
    expect(localStorage.getItem(PORTFOLIO_RANGE_STORAGE_KEY)).toBe("3m");
    expect(activeRange()).toBe("3m");
  });

  it("leaves the invoice period and page size untouched", () => {
    state.filterMode = "week";
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, "50");
    setupPortfolioListeners();

    showPortfolioView();
    clickRange("3m");
    showInvoicesView();

    expect(state.filterMode).toBe("week");
    expect(localStorage.getItem(PAGE_SIZE_STORAGE_KEY)).toBe("50");
  });

  it("does not inherit the invoice period", () => {
    setupPortfolioListeners();
    clickRange("ytd");

    state.filterMode = "year";
    showPortfolioView();

    expect(state.portfolioRange).toBe("ytd");
    expect(activeRange()).toBe("ytd");
  });
});

// A payload in the exact shape `_serialize_*` in summa/routes/portfolio.py emits.
// The numbers are chosen to add up: the rows sum to their depot subtotal, the
// subtotals sum to the grand total, and `invested_eur` differs from
// `contributed_eur` because one position was sold at a profit.
const benchmarkPosition = {
  id: 11,
  depot_id: 1,
  name: "MSCI World SRI",
  kind: "etf",
  currency: "EUR",
  is_benchmark_fallback: true,
  closed_at: null,
  value: 1389.27,
  fx_rate: 1.0,
  value_eur: 1389.27,
  invested_eur: 1300.0,
  contributed_eur: 1300.0,
  gain: 89.27,
  gain_pct: 6.9,
  week_delta: 12.5,
  first_snapshot_date: "2025-01-06",
  last_snapshot_date: "2026-09-06",
  snapshot_count: 27,
};

const usdPosition = {
  id: 12,
  depot_id: 1,
  name: "FTSE All-World",
  kind: "etf",
  currency: "USD",
  is_benchmark_fallback: false,
  closed_at: null,
  value: 445.41,
  fx_rate: 1.08,
  value_eur: 412.42,
  invested_eur: 400.0,
  contributed_eur: 400.0,
  gain: 12.42,
  gain_pct: 3.1,
  week_delta: 5.12,
  first_snapshot_date: "2026-03-01",
  last_snapshot_date: "2026-09-06",
  snapshot_count: 27,
};

const soldPosition = {
  id: 13,
  depot_id: 1,
  name: "AMD",
  kind: "stock",
  currency: "EUR",
  is_benchmark_fallback: false,
  closed_at: "2026-05-12",
  value: 0,
  fx_rate: 1.0,
  value_eur: 0,
  invested_eur: -50.0,
  contributed_eur: 250.0,
  gain: 50.0,
  gain_pct: 20.0,
  week_delta: null,
  first_snapshot_date: "2025-10-01",
  last_snapshot_date: "2026-05-12",
  snapshot_count: 30,
};

const dekaPosition = {
  id: 21,
  depot_id: 2,
  name: "Deka Industrie 0",
  kind: "fund",
  currency: "EUR",
  is_benchmark_fallback: false,
  closed_at: null,
  value: 4925.73,
  fx_rate: 1.0,
  value_eur: 4925.73,
  invested_eur: 4700.0,
  contributed_eur: 4700.0,
  gain: 225.73,
  gain_pct: 4.8,
  week_delta: -33.2,
  first_snapshot_date: "2024-01-01",
  last_snapshot_date: "2026-09-06",
  snapshot_count: 40,
};

const portfolioPayload = () => ({
  range: "1y",
  range_start: "2025-09-14",
  range_end: "2026-09-14",
  depot: null,
  depot_options: [
    { id: 1, name: "Trade Republic" },
    { id: 2, name: "Deka" },
  ],
  depots: [
    {
      id: 1,
      name: "Trade Republic",
      positions: [benchmarkPosition, usdPosition, soldPosition],
      value_eur: 1801.69,
      invested_eur: 1650.0,
      contributed_eur: 1950.0,
      gain: 151.69,
      gain_pct: 7.8,
    },
    {
      id: 2,
      name: "Deka",
      positions: [dekaPosition],
      value_eur: 4925.73,
      invested_eur: 4700.0,
      contributed_eur: 4700.0,
      gain: 225.73,
      gain_pct: 4.8,
    },
  ],
  totals: {
    value_eur: 6727.42,
    invested_eur: 6350.0,
    contributed_eur: 6650.0,
    gain: 377.42,
    gain_pct: 5.7,
    week_delta: -15.58,
    position_count: 4,
    depot_count: 2,
    last_snapshot_date: "2026-09-06",
  },
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
    {
      label: "FTSE All-World",
      value_eur: 412.42,
      share_pct: 6.1,
      aggregated_count: 0,
    },
  ],
  changes: {
    gainers: [{ position_id: 12, name: "FTSE All-World", week_delta: 5.12 }],
    losers: [{ position_id: 21, name: "Deka Industrie 0", week_delta: -33.2 }],
  },
  series: {
    dates: ["2026-08-30", "2026-09-06"],
    portfolio: [6743.0, 6727.42],
    invested: [6350.0, 6350.0],
    benchmark: [6743.0, 6751.4],
    positions: [
      { id: 11, name: "MSCI World SRI", values: [0, 0] },
      { id: 12, name: "FTSE All-World", values: [1796.57, 1801.69] },
      { id: 13, name: "AMD", values: [0, 0] },
      { id: 21, name: "Deka Industrie 0", values: [4958.93, 4925.73] },
    ],
  },
  benchmark_source: "feed",
  benchmark_updated_at: "2026-09-06",
});

const emptyPayload = () => ({
  ...portfolioPayload(),
  depots: [],
  totals: {
    value_eur: 0,
    invested_eur: 0,
    contributed_eur: 0,
    gain: 0,
    gain_pct: null,
    week_delta: 0,
    position_count: 0,
    depot_count: 0,
    last_snapshot_date: null,
  },
});

describe("portfolio formatters", () => {
  it("groups thousands and always shows two decimals", () => {
    expect(formatAmount(16810.7)).toBe("16,810.70");
    expect(formatAmount(0)).toBe("0.00");
    // The backend's rounding can produce a negative zero; it must not surface.
    expect(formatAmount(-0)).toBe("0.00");
  });

  it("writes an explicit sign on gains and losses", () => {
    expect(formatSigned(89.27)).toBe(`+89.27${EUR}`);
    expect(formatSigned(-1234.5)).toBe(`-1,234.50${EUR}`);
    expect(formatSigned(0)).toBe(`+0.00${EUR}`);
  });

  it("renders an undefined percentage as a dash, not as zero", () => {
    expect(formatPercent(6.9)).toBe("+6.9 %");
    expect(formatPercent(-2.25)).toBe("-2.3 %");
    expect(formatPercent(null)).toBe("—");
  });

  it("formats ISO days with dots and no timezone shift", () => {
    expect(formatDateDots("2026-09-06")).toBe("06.09.2026");
    expect(formatDateDots("2026-01-01")).toBe("01.01.2026");
    expect(formatDateDots(null)).toBe("");
  });
});

// The full view shell: the toolbar the existing cases use, plus the three
// containers the renderer writes into and the depot dropdown's markup.
const viewMarkup = `
  <div data-el="topbar-title"></div>
  <nav class="sidebar-nav">
    <button class="nav-item" data-view="invoices"></button>
    <button class="nav-item" data-view="portfolio"></button>
  </nav>
  <div data-el="invoices-view"></div>
  <div class="is-hidden" data-el="stats-view"></div>
  <div class="is-hidden" data-el="portfolio-view">
    <div data-el="portfolio-period">
      <button class="portfolio-period-btn" data-range="1y" aria-pressed="true"></button>
      <button class="portfolio-period-btn" data-range="3m" aria-pressed="false"></button>
    </div>
    <div class="portfolio-depot" data-el="portfolio-depot">
      <button class="portfolio-depot-trigger" aria-expanded="false">
        <span class="portfolio-depot-label">All depots</span>
      </button>
      <ul class="portfolio-depot-menu" role="listbox"></ul>
    </div>
    <div class="portfolio-positions" data-el="portfolio-positions">
      <button class="portfolio-positions-trigger" aria-expanded="false">
        <span class="portfolio-positions-label">Total portfolio</span>
      </button>
      <ul class="portfolio-positions-menu" role="listbox"></ul>
    </div>
    <div class="portfolio-summary is-hidden" data-el="portfolio-summary"></div>
    <div class="is-hidden" data-el="portfolio-chart-card">
      <div data-el="portfolio-legend-static">
        <span class="is-hidden" data-el="portfolio-legend-benchmark"></span>
      </div>
      <div class="is-hidden" data-el="portfolio-legend-series"></div>
      <div class="portfolio-chart-body"><canvas data-el="portfolio-chart"></canvas></div>
      <div class="is-hidden" data-el="portfolio-chart-empty"></div>
      <div data-el="portfolio-chart-note"></div>
    </div>
    <div class="portfolio-list is-hidden" data-el="portfolio-list"></div>
    <div class="portfolio-bottom is-hidden" data-el="portfolio-bottom">
      <div class="portfolio-donut"><canvas data-el="portfolio-allocation-chart"></canvas></div>
      <div data-el="portfolio-allocation-legend"></div>
      <div data-el="portfolio-changes"></div>
    </div>
    <div class="portfolio-empty is-hidden" data-el="portfolio-empty"></div>
  </div>
`;

// The formatters join amount and symbol with a non-breaking space (dom.js).
const EUR = " €";

const summaryText = () =>
  document.querySelector('[data-el="portfolio-summary"]').textContent;
const listEl = () => document.querySelector('[data-el="portfolio-list"]');
const rowFor = (id) =>
  document.querySelector(`.portfolio-row[data-position-id="${id}"]`);
const lastRequest = () => global.fetch.mock.calls.at(-1)[0];

describe("portfolio rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = viewMarkup;
    document.body.className = "";
    localStorage.clear();
    collapsedDepots.clear();
    expandedPositions.clear();
    state.portfolioRange = "1y";
    state.depotFilter = "all";
    vi.clearAllMocks();
    // happy-dom hands a canvas no 2D context, so the real Chart.js would throw.
    // A function declaration, not an arrow: the charts call it with `new`.
    globalThis.Chart = vi.fn(function ChartStub() {
      this.destroy = vi.fn();
    });
    global.fetch = vi.fn(async () => jsonResponse(portfolioPayload()));
    setupPortfolioListeners();
  });

  it("requests the active period and omits the depot when unfiltered", async () => {
    await loadPortfolio();

    expect(lastRequest()).toBe("/api/portfolio?range=1y");
  });

  it("redraws the chart when the viewport crosses the breakpoint", async () => {
    await loadPortfolio();
    const requests = global.fetch.mock.calls.length;
    globalThis.Chart.mockClear();

    mobileViewport.dispatchEvent(new Event("change"));

    // Drawn again from the cached payload, so the tick budget and the y-label
    // format follow the new width without another round trip.
    expect(globalThis.Chart).toHaveBeenCalled();
    expect(global.fetch.mock.calls).toHaveLength(requests);
  });

  it("renders the summary cards, naming the net amount only when it differs", async () => {
    await loadPortfolio();

    expect(summaryText()).toContain(`6,727.42${EUR}`);
    expect(summaryText()).toContain(`+377.42${EUR}`);
    expect(summaryText()).toContain("+5.7 %");
    // contributed_eur is the headline, invested_eur the divergent net figure.
    expect(summaryText()).toContain(`6,650.00${EUR}`);
    expect(summaryText()).toContain(`net 6,350.00${EUR}`);
    expect(summaryText()).toContain("4 positions · 2 depots");
    expect(summaryText()).toContain(`-15.58${EUR}`);
    expect(summaryText()).toContain("snapshot 06.09.2026");
  });

  it("drops the net line when nothing has been sold", async () => {
    const payload = portfolioPayload();
    payload.totals.invested_eur = payload.totals.contributed_eur;
    global.fetch = vi.fn(async () => jsonResponse(payload));

    await loadPortfolio();

    expect(summaryText()).toContain("4 positions · 2 depots");
    expect(summaryText()).not.toContain("net ");
  });

  it("renders every depot group with its subtotal, and rows that sum to it", async () => {
    await loadPortfolio();

    const headers = [...document.querySelectorAll(".portfolio-group-header")];
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain("Trade Republic · 3 positions");
    expect(headers[0].textContent).toContain(`1,801.69${EUR}`);
    expect(headers[1].textContent).toContain("Deka · 1 position");

    const groupRows = [
      ...headers[0]
        .closest(".portfolio-group")
        .querySelectorAll(".portfolio-row-value"),
    ].map((cell) => Number(cell.textContent.replace(/[^\d.-]/g, "")));
    expect(groupRows.reduce((sum, value) => sum + value, 0)).toBeCloseTo(
      1801.69,
      2,
    );
  });

  it("puts the grand total in the footer, matching the hero card", async () => {
    await loadPortfolio();

    const footer = document.querySelector(".portfolio-list-total");
    expect(footer.textContent).toBe(`6,727.42${EUR}`);
    expect(summaryText()).toContain(`6,727.42${EUR}`);
  });

  it("marks the footer's invested column net, unlike the card above it", async () => {
    await loadPortfolio();

    expect(
      document.querySelector(".portfolio-list-legend").textContent,
    ).toContain("net invested");
    const net = document.querySelector(".portfolio-list-net");
    expect(net.textContent).toContain("net");
    // invested_eur, next to the card's contributed_eur — two figures, two labels.
    expect(net.textContent).toContain(`6,350.00${EUR}`);
    expect(summaryText()).toContain(`6,650.00${EUR}`);
  });

  it("keeps a sold position in its group, marked and muted", async () => {
    await loadPortfolio();

    const sold = rowFor(13);
    expect(sold.classList.contains("is-closed")).toBe(true);
    expect(sold.textContent).toContain("sold 12.05.2026");
    expect(sold.querySelector(".portfolio-row-value").textContent).toBe(
      `0.00${EUR}`,
    );
    // Its realized gain is what keeps the rows summing to the grand total.
    expect(sold.querySelector(".portfolio-row-gain").textContent).toBe(
      `+50.00${EUR}`,
    );
  });

  it("names the sale date of a position sold before it was ever snapshotted", async () => {
    // closed_at is the sale date itself; last_snapshot_date is only a proxy for
    // it, and one that is null exactly here.
    const payload = portfolioPayload();
    payload.depots[0].positions[2] = {
      ...soldPosition,
      first_snapshot_date: null,
      last_snapshot_date: null,
      snapshot_count: 0,
    };
    global.fetch = vi.fn(async () => jsonResponse(payload));

    await loadPortfolio();

    expect(rowFor(13).textContent).toContain("sold 12.05.2026");
  });

  it("qualifies only a position that started inside the window", async () => {
    await loadPortfolio();

    expect(rowFor(12).textContent).toContain("since 01.03.2026");
    expect(rowFor(11).textContent).not.toContain("since");
  });

  it("badges the benchmark fallback position", async () => {
    await loadPortfolio();

    const badge = rowFor(11).querySelector(
      ".portfolio-row-meta .portfolio-badge",
    );
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("Fallback");
    expect(badge.getAttribute("title")).toBe("Benchmark fallback");
    expect(rowFor(12).querySelector(".portfolio-badge")).toBeNull();
  });

  // The name line is a single clipping line, so a badge beside it is cut off
  // mid-word once the amount columns squeeze it (see positionMeta).
  it("keeps the fallback badge out of the name line and spells it out for a screen reader", async () => {
    await loadPortfolio();

    expect(
      rowFor(11).querySelector(".portfolio-row-name .portfolio-badge"),
    ).toBeNull();
    expect(
      rowFor(11).querySelector(".portfolio-row-meta .visually-hidden")
        .textContent,
    ).toBe("Benchmark fallback");
  });

  it("shows the empty state and hides the data sections when there are no positions", async () => {
    global.fetch = vi.fn(async () => jsonResponse(emptyPayload()));

    await loadPortfolio();

    expect(
      document.querySelector('[data-el="portfolio-empty"]').classList,
    ).not.toContain("is-hidden");
    expect(listEl().classList.contains("is-hidden")).toBe(true);
    expect(
      document
        .querySelector('[data-el="portfolio-summary"]')
        .classList.contains("is-hidden"),
    ).toBe(true);
    // The class the CSS hangs both snapshot triggers off.
    expect(document.body.classList.contains("portfolio-no-positions")).toBe(
      true,
    );
  });

  it("keeps a fully sold portfolio visible instead of falling back to the empty state", async () => {
    // Everything sold: `position_count` counts only what is still held and is 0
    // here, but the depot, its row and the realized gain are still worth showing.
    const payload = portfolioPayload();
    payload.depots = [
      { ...payload.depots[0], positions: [soldPosition], value_eur: 0 },
    ];
    payload.totals = { ...payload.totals, position_count: 0, value_eur: 0 };
    global.fetch = vi.fn(async () => jsonResponse(payload));

    await loadPortfolio();

    expect(
      document
        .querySelector('[data-el="portfolio-empty"]')
        .classList.contains("is-hidden"),
    ).toBe(true);
    expect(listEl().classList.contains("is-hidden")).toBe(false);
    // ... and it keeps its snapshot triggers: more weeks can still be recorded.
    expect(document.body.classList.contains("portfolio-no-positions")).toBe(
      false,
    );
    expect(rowFor(13).querySelector(".portfolio-row-gain").textContent).toBe(
      `+50.00${EUR}`,
    );
  });

  it("reports a failed load without blanking what is already on screen", async () => {
    await loadPortfolio();
    const rendered = listEl().innerHTML;

    global.fetch = vi.fn(async () =>
      jsonResponse({}, { ok: false, status: 500 }),
    );
    await loadPortfolio();

    expect(showErrorToast).toHaveBeenCalledWith("Failed to load portfolio");
    expect(listEl().innerHTML).toBe(rendered);
  });
});

// A collapsed group body and a closed detail strip are hidden by CSS only (a
// zero-height grid row), so `inert` is the sole thing keeping their rows out of
// the tab order and the accessibility tree. These tests pin that contract
// alongside the visual one.
describe("portfolio group collapsing and row expansion", () => {
  beforeEach(async () => {
    document.body.innerHTML = viewMarkup;
    localStorage.clear();
    collapsedDepots.clear();
    expandedPositions.clear();
    state.portfolioRange = "1y";
    state.depotFilter = "all";
    vi.clearAllMocks();
    // happy-dom hands a canvas no 2D context, so the real Chart.js would throw.
    // A function declaration, not an arrow: the charts call it with `new`.
    globalThis.Chart = vi.fn(function ChartStub() {
      this.destroy = vi.fn();
    });
    global.fetch = vi.fn(async () => jsonResponse(portfolioPayload()));
    setupPortfolioListeners();
    await loadPortfolio();
  });

  it("collapses a group and keeps it collapsed across a refetch", async () => {
    const header = document.querySelector(".portfolio-group-header");
    header.click();

    const group = header.closest(".portfolio-group");
    expect(group.classList.contains("is-collapsed")).toBe(true);
    expect(group.querySelector(".portfolio-group-body").inert).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.getAttribute("aria-controls")).toBe(
      group.querySelector(".portfolio-group-body").id,
    );
    expect(collapsedDepots.has(1)).toBe(true);

    await loadPortfolio();

    const reRendered = document.querySelector(".portfolio-group");
    expect(reRendered.classList.contains("is-collapsed")).toBe(true);
    expect(reRendered.querySelector(".portfolio-group-body").inert).toBe(true);

    document.querySelector(".portfolio-group-header").click();

    expect(reRendered.classList.contains("is-collapsed")).toBe(false);
    expect(reRendered.querySelector(".portfolio-group-body").inert).toBe(false);
    expect(collapsedDepots.has(1)).toBe(false);
  });

  it("keeps every collapsed row's aria-controls target in the DOM", async () => {
    const rows = [...document.querySelectorAll(".portfolio-row")];
    expect(rows.length).toBeGreaterThan(0);

    rows.forEach((row) => {
      const strip = document.getElementById(row.getAttribute("aria-controls"));
      expect(strip).not.toBeNull();
      expect(strip.classList.contains("is-open")).toBe(false);
      expect(strip.inert).toBe(true);
      expect(row.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("reveals the detail strip without touching the row's own markup", async () => {
    const row = rowFor(11);
    const before = row.innerHTML;
    row.click();

    const strip = row.nextElementSibling;
    expect(strip.classList.contains("portfolio-detail")).toBe(true);
    expect(strip.classList.contains("is-open")).toBe(true);
    expect(strip.inert).toBe(false);
    expect(strip.textContent).toContain("1.0000");
    expect(strip.textContent).toContain("27");
    expect(rowFor(11).innerHTML).toBe(before);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.getAttribute("aria-controls")).toBe(strip.id);
  });

  it("keeps several rows open at once and closes them individually", async () => {
    rowFor(11).click();
    rowFor(12).click();
    expect(document.querySelectorAll(".portfolio-detail.is-open")).toHaveLength(
      2,
    );

    rowFor(11).click();
    expect(document.querySelectorAll(".portfolio-detail.is-open")).toHaveLength(
      1,
    );
    expect(rowFor(11).nextElementSibling.inert).toBe(true);
    expect(rowFor(12).nextElementSibling.inert).toBe(false);
    expect(expandedPositions.has(11)).toBe(false);
    expect(expandedPositions.has(12)).toBe(true);
  });

  it("renders a closed position's missing week delta as a dash", async () => {
    rowFor(13).click();

    expect(rowFor(13).nextElementSibling.textContent).toContain("—");
  });

  it("opens the history dialog without collapsing the row it sits in", async () => {
    const row = rowFor(11);
    row.click();

    row.nextElementSibling
      .querySelector('[data-action="show-history"]')
      .click();

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(expandedPositions.has(11)).toBe(true);
    expect(openHistoryModal).toHaveBeenCalledWith(11, "MSCI World SRI");
  });

  it("re-opens the same rows after a refetch", async () => {
    rowFor(12).click();
    await loadPortfolio();

    expect(rowFor(12).getAttribute("aria-expanded")).toBe("true");
    expect(rowFor(12).nextElementSibling.inert).toBe(false);
    expect(document.querySelectorAll(".portfolio-detail.is-open")).toHaveLength(
      1,
    );
  });
});

describe("portfolio position filter", () => {
  beforeEach(() => {
    document.body.innerHTML = viewMarkup;
    localStorage.clear();
    collapsedDepots.clear();
    expandedPositions.clear();
    state.portfolioRange = "1y";
    state.depotFilter = "all";
    state.portfolioPositions = "all";
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => jsonResponse(portfolioPayload()));
  });

  const openMenu = () =>
    document
      .querySelector(".portfolio-positions-trigger")
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

  const clickOption = (index) => {
    const rows = document.querySelectorAll(".portfolio-positions-option");
    rows[index].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  };

  const positionsLabel = () =>
    document.querySelector(".portfolio-positions-label").textContent;

  const pickDepot = async (index) => {
    document
      .querySelector(".portfolio-depot-trigger")
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const rows = document.querySelectorAll(".portfolio-depot-option");
    rows[index].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushUi();
  };

  /** The payload the server answers a depot filter with: its depot only. */
  const narrowedToDepot = (id) => {
    const payload = portfolioPayload();
    const depot = payload.depots.find((entry) => entry.id === id);
    const ids = new Set(depot.positions.map((position) => position.id));
    payload.depot = id;
    payload.depots = [depot];
    payload.series.positions = payload.series.positions.filter((entry) =>
      ids.has(entry.id),
    );
    return payload;
  };

  it("offers every position the series carries, in the payload's order", async () => {
    setupPortfolioListeners();
    await loadPortfolio();
    openMenu();

    const labels = [
      ...document.querySelectorAll(".portfolio-positions-option"),
    ].map((option) => option.textContent.trim());
    expect(labels).toEqual([
      "Total portfolio",
      "MSCI World SRI",
      "FTSE All-World",
      "AMD",
      "Deka Industrie 0",
    ]);
  });

  it("persists a pick and redraws without asking the server again", async () => {
    setupPortfolioListeners();
    await loadPortfolio();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    openMenu();
    clickOption(2);
    await flushUi();

    expect(state.portfolioPositions).toEqual([12]);
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe("[12]");
    // The lines were already in the payload, so nothing was refetched.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("stores the sentinel, not an empty list, once the last pick is cleared", async () => {
    setupPortfolioListeners();
    await loadPortfolio();

    openMenu();
    clickOption(2);
    clickOption(2);
    await flushUi();

    expect(state.portfolioPositions).toBe("all");
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe("all");
  });

  it("shows a restored selection on the trigger before any click", async () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[21]");
    restorePortfolioPrefs();
    setupPortfolioListeners();
    await loadPortfolio();

    expect(
      document.querySelector(".portfolio-positions-label").textContent,
    ).toBe("Deka Industrie 0");
  });

  it("draws only the stored positions the payload carries, without forgetting the rest", async () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[12,99]");
    restorePortfolioPrefs();
    setupPortfolioListeners();

    await loadPortfolio();

    // 99 is kept: a missing id is either gone for good or merely filtered out,
    // and this side cannot tell the two apart.
    expect(state.portfolioPositions).toEqual([12, 99]);
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe(
      "[12,99]",
    );
    expect(positionsLabel()).toBe("FTSE All-World");
    // A selection is not part of the request, so nothing is retried.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("shows every position when none of the stored ones are available", async () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[98,99]");
    restorePortfolioPrefs();
    setupPortfolioListeners();

    await loadPortfolio();

    expect(state.portfolioPositions).toEqual([98, 99]);
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe(
      "[98,99]",
    );
    expect(positionsLabel()).toBe("Total portfolio");
  });

  it("restores the selection when the depot filter comes back", async () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[11,12]");
    restorePortfolioPrefs();
    global.fetch = vi.fn(async (url) =>
      jsonResponse(
        url.includes("depot=2") ? narrowedToDepot(2) : portfolioPayload(),
      ),
    );
    setupPortfolioListeners();
    await loadPortfolio();
    expect(positionsLabel()).toBe("2 positions");

    await pickDepot(2);

    // Neither of the two is in this depot, so the chart falls back to the
    // aggregate — but nothing about that is persisted.
    expect(positionsLabel()).toBe("Total portfolio");
    expect(state.portfolioPositions).toEqual([11, 12]);
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe(
      "[11,12]",
    );

    await pickDepot(0);

    expect(positionsLabel()).toBe("2 positions");
    expect(state.portfolioPositions).toEqual([11, 12]);
  });

  it("keeps the hidden picks when a pick is made in another depot", async () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[11,12]");
    restorePortfolioPrefs();
    global.fetch = vi.fn(async (url) =>
      jsonResponse(
        url.includes("depot=2") ? narrowedToDepot(2) : portfolioPayload(),
      ),
    );
    setupPortfolioListeners();
    await loadPortfolio();
    await pickDepot(2);

    openMenu();
    clickOption(1);
    await flushUi();

    // A toggle edits what is on screen; the two ids this depot hides ride
    // along, so the switch stays as reversible as it was before the pick.
    expect(state.portfolioPositions).toEqual([21, 11, 12]);
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe(
      "[21,11,12]",
    );
    expect(positionsLabel()).toBe("Deka Industrie 0");

    await pickDepot(0);

    expect(positionsLabel()).toBe("3 positions");
  });

  it("clears the hidden picks as well when the total portfolio row is used", async () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[11,12]");
    restorePortfolioPrefs();
    global.fetch = vi.fn(async (url) =>
      jsonResponse(
        url.includes("depot=2") ? narrowedToDepot(2) : portfolioPayload(),
      ),
    );
    setupPortfolioListeners();
    await loadPortfolio();
    await pickDepot(2);

    openMenu();
    clickOption(0);
    await flushUi();

    // The one row that is not a position is a reset, not a toggle.
    expect(state.portfolioPositions).toBe("all");
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe("all");

    await pickDepot(0);

    expect(positionsLabel()).toBe("Total portfolio");
  });

  it("keeps the hidden picks when the last visible one is unchecked", async () => {
    localStorage.setItem(PORTFOLIO_POSITIONS_STORAGE_KEY, "[11,21]");
    restorePortfolioPrefs();
    global.fetch = vi.fn(async (url) =>
      jsonResponse(
        url.includes("depot=2") ? narrowedToDepot(2) : portfolioPayload(),
      ),
    );
    setupPortfolioListeners();
    await loadPortfolio();
    await pickDepot(2);

    openMenu();
    clickOption(1);
    await flushUi();

    // Unchecking the only visible row reads as "all" on the control, but it
    // says nothing about the row this depot does not show.
    expect(positionsLabel()).toBe("Total portfolio");
    expect(state.portfolioPositions).toEqual([11]);
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe("[11]");
  });

  /** Stored ids no depot carries, so a depot filter hides every one of them. */
  const hiddenIds = (count) =>
    Array.from({ length: count }, (unused, index) => 900 + index);

  /** Load with `stored` persisted, then narrow to depot 2. */
  const filteredWithStored = async (stored) => {
    localStorage.setItem(
      PORTFOLIO_POSITIONS_STORAGE_KEY,
      JSON.stringify(stored),
    );
    restorePortfolioPrefs();
    global.fetch = vi.fn(async (url) =>
      jsonResponse(
        url.includes("depot=2") ? narrowedToDepot(2) : portfolioPayload(),
      ),
    );
    setupPortfolioListeners();
    await loadPortfolio();
    await pickDepot(2);
  };

  it("refuses a pick that the hidden ones have already spent the palette on", async () => {
    await filteredWithStored(hiddenIds(PORTFOLIO_MAX_LINES));

    openMenu();
    const rows = [...document.querySelectorAll(".portfolio-positions-option")];
    // Not one row is checked here, and every one of them is still greyed out:
    // the palette is spent on lines this depot does not show.
    expect(
      rows.slice(1).every((row) => row.classList.contains("is-disabled")),
    ).toBe(true);
    expect(
      document.querySelector(".portfolio-positions-hint").textContent,
    ).toBe(
      `Max. ${PORTFOLIO_MAX_LINES} lines · ${PORTFOLIO_MAX_LINES} in other depots`,
    );

    clickOption(1);
    await flushUi();

    // The refusal is the point: nothing is evicted behind the user's back.
    expect(state.portfolioPositions).toEqual(hiddenIds(PORTFOLIO_MAX_LINES));
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe(
      JSON.stringify(hiddenIds(PORTFOLIO_MAX_LINES)),
    );
  });

  it("offers a way out when the hidden picks alone have spent the palette", async () => {
    await filteredWithStored(hiddenIds(PORTFOLIO_MAX_LINES));

    openMenu();
    const reset = document.querySelector(".portfolio-positions-reset");
    // The "all" row above is checked here and so reads as the state in force;
    // this row is the only thing on screen that offers to change it.
    expect(reset.textContent).toBe(
      `Clear ${PORTFOLIO_MAX_LINES} picks in other depots`,
    );

    reset.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushUi();

    expect(state.portfolioPositions).toBe("all");
    expect(localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY)).toBe("all");
    expect(positionsLabel()).toBe("Total portfolio");

    // And the list takes picks again, in the depot the user is actually in.
    const rows = [...document.querySelectorAll(".portfolio-positions-option")];
    expect(
      rows.slice(1).some((row) => row.classList.contains("is-disabled")),
    ).toBe(false);
    expect(document.querySelector(".portfolio-positions-reset")).toBeNull();
  });

  it("takes the pick that fills the last palette slot, visible ids first", async () => {
    const hidden = hiddenIds(PORTFOLIO_MAX_LINES - 1);
    await filteredWithStored(hidden);

    openMenu();
    clickOption(1);
    await flushUi();

    expect(state.portfolioPositions).toEqual([21, ...hidden]);
    expect(positionLineColors.has(21)).toBe(true);

    // And it took the last slot: the hint says so, counting the seven it
    // cannot show alongside the one it just checked.
    expect(
      document.querySelector(".portfolio-positions-hint").textContent,
    ).toBe(
      `Max. ${PORTFOLIO_MAX_LINES} lines · ${hidden.length} in other depots`,
    );
  });
});

describe("portfolio depot filter", () => {
  beforeEach(() => {
    document.body.innerHTML = viewMarkup;
    localStorage.clear();
    collapsedDepots.clear();
    expandedPositions.clear();
    state.portfolioRange = "1y";
    state.depotFilter = "all";
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => jsonResponse(portfolioPayload()));
  });

  it("offers every depot plus the all-depots row", async () => {
    setupPortfolioListeners();
    await loadPortfolio();

    document
      .querySelector(".portfolio-depot-trigger")
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const options = [
      ...document.querySelectorAll(".portfolio-depot-option"),
    ].map((option) => option.textContent.trim());
    expect(options).toEqual(["All depots", "Trade Republic", "Deka"]);
  });

  it("narrows the request and persists the pick", async () => {
    setupPortfolioListeners();
    await loadPortfolio();

    const trigger = document.querySelector(".portfolio-depot-trigger");
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document
      .querySelectorAll(".portfolio-depot-option")[2]
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushUi();

    expect(state.depotFilter).toBe("2");
    expect(localStorage.getItem(PORTFOLIO_DEPOT_STORAGE_KEY)).toBe("2");
    expect(lastRequest()).toBe("/api/portfolio?range=1y&depot=2");
    expect(document.querySelector(".portfolio-depot-label").textContent).toBe(
      "Deka",
    );
  });

  it("drops a stored depot the server no longer knows and reloads unfiltered", async () => {
    localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, "99");
    restorePortfolioPrefs();
    setupPortfolioListeners();

    await loadPortfolio();

    expect(state.depotFilter).toBe("all");
    expect(localStorage.getItem(PORTFOLIO_DEPOT_STORAGE_KEY)).toBeNull();
    expect(lastRequest()).toBe("/api/portfolio?range=1y");
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("recovers the same way when the server rejects the depot id outright", async () => {
    localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, "99");
    restorePortfolioPrefs();
    setupPortfolioListeners();
    global.fetch = vi.fn(async (url) =>
      url.includes("depot=")
        ? jsonResponse({ error: "Depot not found" }, { ok: false, status: 400 })
        : jsonResponse(portfolioPayload()),
    );

    await loadPortfolio();

    expect(state.depotFilter).toBe("all");
    expect(lastRequest()).toBe("/api/portfolio?range=1y");
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".portfolio-row")).toHaveLength(4);
  });

  it("keeps the depot filter when the request fails for any other reason", async () => {
    localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, "2");
    restorePortfolioPrefs();
    setupPortfolioListeners();
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await loadPortfolio();

    expect(state.depotFilter).toBe("2");
    expect(localStorage.getItem(PORTFOLIO_DEPOT_STORAGE_KEY)).toBe("2");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(showErrorToast).toHaveBeenCalled();
  });

  it("keeps the depot filter when the server fails with a 500", async () => {
    localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, "2");
    restorePortfolioPrefs();
    setupPortfolioListeners();
    global.fetch = vi.fn(async () =>
      jsonResponse({}, { ok: false, status: 500 }),
    );

    await loadPortfolio();

    expect(state.depotFilter).toBe("2");
    expect(localStorage.getItem(PORTFOLIO_DEPOT_STORAGE_KEY)).toBe("2");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(showErrorToast).toHaveBeenCalled();
  });
});
