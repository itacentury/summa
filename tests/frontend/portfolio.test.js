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
  PORTFOLIO_RANGE_STORAGE_KEY,
} from "../../static/js/state.js";
import { showErrorToast } from "../../static/js/toast.js";
import { showInvoicesView, showPortfolioView } from "../../static/js/views.js";
import { flushUi, jsonResponse } from "./helpers.js";

vi.mock("../../static/js/stats.js", () => ({ loadStats: vi.fn() }));
vi.mock("../../static/js/drawer.js", () => ({ closeMobileSearch: vi.fn() }));
vi.mock("../../static/js/toast.js", () => ({ showErrorToast: vi.fn() }));

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
      <button class="portfolio-period-btn" data-range="3m"></button>
      <button class="portfolio-period-btn is-active" data-range="1y"></button>
      <button class="portfolio-period-btn" data-range="ytd"></button>
      <button class="portfolio-period-btn" data-range="max"></button>
    </div>
  </div>
`;

const activeRange = () =>
  document.querySelector(".portfolio-period-btn.is-active")?.dataset.range;

const clickRange = (range) =>
  document
    .querySelector(`.portfolio-period-btn[data-range="${range}"]`)
    .click();

describe("restorePortfolioPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
    state.portfolioRange = "1y";
    state.depotFilter = "all";
  });

  it("keeps the defaults when nothing is stored", () => {
    restorePortfolioPrefs();

    expect(state.portfolioRange).toBe("1y");
    expect(state.depotFilter).toBe("all");
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
  allocation: [],
  changes: { gainers: [], losers: [] },
  series: { dates: [], portfolio: [], invested: [], benchmark: [] },
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
    expect(formatSigned(89.27)).toBe("+89.27 €");
    expect(formatSigned(-1234.5)).toBe("-1,234.50 €");
    expect(formatSigned(0)).toBe("+0.00 €");
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
      <button class="portfolio-period-btn is-active" data-range="1y"></button>
      <button class="portfolio-period-btn" data-range="3m"></button>
    </div>
    <div class="portfolio-depot" data-el="portfolio-depot">
      <button class="portfolio-depot-trigger" aria-expanded="false">
        <span class="portfolio-depot-label">All depots</span>
      </button>
      <ul class="portfolio-depot-menu" role="listbox"></ul>
    </div>
    <div class="portfolio-summary is-hidden" data-el="portfolio-summary"></div>
    <div class="portfolio-list is-hidden" data-el="portfolio-list"></div>
    <div class="portfolio-empty is-hidden" data-el="portfolio-empty"></div>
  </div>
`;

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
    global.fetch = vi.fn(async () => jsonResponse(portfolioPayload()));
    setupPortfolioListeners();
  });

  it("requests the active period and omits the depot when unfiltered", async () => {
    await loadPortfolio();

    expect(lastRequest()).toBe("/api/portfolio?range=1y");
  });

  it("renders the summary cards, naming the net amount only when it differs", async () => {
    await loadPortfolio();

    expect(summaryText()).toContain("€ 6,727.42");
    expect(summaryText()).toContain("+377.42 €");
    expect(summaryText()).toContain("+5.7 %");
    // contributed_eur is the headline, invested_eur the divergent net figure.
    expect(summaryText()).toContain("€ 6,650.00");
    expect(summaryText()).toContain("net € 6,350.00");
    expect(summaryText()).toContain("4 positions · 2 depots");
    expect(summaryText()).toContain("-15.58 €");
    expect(summaryText()).toContain("snapshot 06.09.2026");
  });

  it("drops the net line when nothing has been sold", async () => {
    const payload = portfolioPayload();
    payload.totals.invested_eur = payload.totals.contributed_eur;
    global.fetch = vi.fn(async () => jsonResponse(payload));

    await loadPortfolio();

    expect(summaryText()).toContain("4 positions · 2 depots");
    expect(summaryText()).not.toContain("net €");
  });

  it("renders every depot group with its subtotal, and rows that sum to it", async () => {
    await loadPortfolio();

    const headers = [...document.querySelectorAll(".portfolio-group-header")];
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain("Trade Republic · 3 positions");
    expect(headers[0].textContent).toContain("€ 1,801.69");
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
    expect(footer.textContent).toBe("6,727.42 €");
    expect(summaryText()).toContain("€ 6,727.42");
  });

  it("marks the footer's invested column net, unlike the card above it", async () => {
    await loadPortfolio();

    expect(
      document.querySelector(".portfolio-list-legend").textContent,
    ).toContain("net invested");
    const net = document.querySelector(".portfolio-list-net");
    expect(net.textContent).toContain("net");
    // invested_eur, next to the card's contributed_eur — two figures, two labels.
    expect(net.textContent).toContain("6,350.00 €");
    expect(summaryText()).toContain("€ 6,650.00");
  });

  it("keeps a sold position in its group, marked and muted", async () => {
    await loadPortfolio();

    const sold = rowFor(13);
    expect(sold.classList.contains("is-closed")).toBe(true);
    expect(sold.textContent).toContain("sold 12.05.2026");
    expect(sold.querySelector(".portfolio-row-value").textContent).toBe(
      "0.00 €",
    );
    // Its realized gain is what keeps the rows summing to the grand total.
    expect(sold.querySelector(".portfolio-row-gain").textContent).toBe(
      "+50.00 €",
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

    expect(rowFor(11).querySelector(".portfolio-badge")).not.toBeNull();
    expect(rowFor(12).querySelector(".portfolio-badge")).toBeNull();
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
    expect(rowFor(13).querySelector(".portfolio-row-gain").textContent).toBe(
      "+50.00 €",
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

describe("portfolio group collapsing and row expansion", () => {
  beforeEach(async () => {
    document.body.innerHTML = viewMarkup;
    localStorage.clear();
    collapsedDepots.clear();
    expandedPositions.clear();
    state.portfolioRange = "1y";
    state.depotFilter = "all";
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => jsonResponse(portfolioPayload()));
    setupPortfolioListeners();
    await loadPortfolio();
  });

  it("collapses a group and keeps it collapsed across a refetch", async () => {
    const header = document.querySelector(".portfolio-group-header");
    header.click();

    const group = header.closest(".portfolio-group");
    expect(group.classList.contains("is-collapsed")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.getAttribute("aria-controls")).toBe(
      group.querySelector(".portfolio-group-body").id,
    );
    expect(collapsedDepots.has(1)).toBe(true);

    await loadPortfolio();

    expect(
      document
        .querySelector(".portfolio-group")
        .classList.contains("is-collapsed"),
    ).toBe(true);
  });

  it("keeps every collapsed row's aria-controls target in the DOM", async () => {
    const rows = [...document.querySelectorAll(".portfolio-row")];
    expect(rows.length).toBeGreaterThan(0);

    rows.forEach((row) => {
      const strip = document.getElementById(row.getAttribute("aria-controls"));
      expect(strip).not.toBeNull();
      expect(strip.hidden).toBe(true);
      expect(row.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("reveals the detail strip without touching the row's own markup", async () => {
    const row = rowFor(11);
    const before = row.innerHTML;
    row.click();

    const strip = row.nextElementSibling;
    expect(strip.classList.contains("portfolio-detail")).toBe(true);
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain("1.0000");
    expect(strip.textContent).toContain("27");
    expect(rowFor(11).innerHTML).toBe(before);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.getAttribute("aria-controls")).toBe(strip.id);
  });

  it("keeps several rows open at once and closes them individually", async () => {
    rowFor(11).click();
    rowFor(12).click();
    expect(
      document.querySelectorAll(".portfolio-detail:not([hidden])"),
    ).toHaveLength(2);

    rowFor(11).click();
    expect(
      document.querySelectorAll(".portfolio-detail:not([hidden])"),
    ).toHaveLength(1);
    expect(expandedPositions.has(11)).toBe(false);
    expect(expandedPositions.has(12)).toBe(true);
  });

  it("renders a closed position's missing week delta as a dash", async () => {
    rowFor(13).click();

    expect(rowFor(13).nextElementSibling.textContent).toContain("—");
  });

  it("re-opens the same rows after a refetch", async () => {
    rowFor(12).click();
    await loadPortfolio();

    expect(rowFor(12).getAttribute("aria-expanded")).toBe("true");
    expect(
      document.querySelectorAll(".portfolio-detail:not([hidden])"),
    ).toHaveLength(1);
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
