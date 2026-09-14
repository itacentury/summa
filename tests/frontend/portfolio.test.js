/**
 * Portfolio view: restoring the persisted preferences and the period switcher.
 *
 * The point of these cases is isolation — the portfolio period and the invoice
 * period are separate state with separate storage keys, and neither view may
 * inherit the other's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  restorePortfolioPrefs,
  setupPortfolioListeners,
} from "../../static/js/portfolio.js";
import {
  state,
  PAGE_SIZE_STORAGE_KEY,
  PORTFOLIO_DEPOT_STORAGE_KEY,
  PORTFOLIO_RANGE_STORAGE_KEY,
} from "../../static/js/state.js";
import { showInvoicesView, showPortfolioView } from "../../static/js/views.js";

vi.mock("../../static/js/stats.js", () => ({ loadStats: vi.fn() }));
vi.mock("../../static/js/drawer.js", () => ({ closeMobileSearch: vi.fn() }));

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
