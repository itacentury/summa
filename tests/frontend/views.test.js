/**
 * View switching between the three top-level areas.
 *
 * The contract under test is exclusivity: exactly one view root is visible, one
 * nav item is active, and the body carries at most one view-mode class. The
 * dispatch is covered too, because the listener it replaced routed every
 * unrecognised `data-view` to the invoices view.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  setupViewListeners,
  showInvoicesView,
  showPortfolioView,
  showStatsView,
} from "../../static/js/views.js";
import { state } from "../../static/js/state.js";

vi.mock("../../static/js/stats.js", () => ({ loadStats: vi.fn() }));
vi.mock("../../static/js/portfolio.js", () => ({ loadPortfolio: vi.fn() }));
vi.mock("../../static/js/drawer.js", () => ({ closeMobileSearch: vi.fn() }));

const markup = `
  <div data-el="topbar-title"></div>
  <nav class="sidebar-nav">
    <button class="nav-item active" data-view="invoices"></button>
    <button class="nav-item" data-view="stats"></button>
    <button class="nav-item" data-view="portfolio"></button>
    <button class="nav-item" data-view="nonsense"></button>
  </nav>
  <div data-el="invoices-view"></div>
  <div class="is-hidden" data-el="stats-view"></div>
  <div class="is-hidden" data-el="portfolio-view"></div>
`;

const visibleViews = () =>
  ["invoices-view", "stats-view", "portfolio-view"].filter(
    (hook) =>
      !document
        .querySelector(`[data-el="${hook}"]`)
        .classList.contains("is-hidden"),
  );

const activeViews = () =>
  [...document.querySelectorAll(".nav-item.active")].map(
    (button) => button.dataset.view,
  );

const title = () =>
  document.querySelector('[data-el="topbar-title"]').textContent;

describe("view switching", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    document.body.className = "";
    state.currentView = "invoices";
  });

  it("shows only the portfolio view", () => {
    showPortfolioView();

    expect(state.currentView).toBe("portfolio");
    expect(visibleViews()).toEqual(["portfolio-view"]);
    expect(activeViews()).toEqual(["portfolio"]);
    expect(title()).toBe("Portfolio");
    expect(document.body.classList.contains("portfolio-mode")).toBe(true);
    expect(document.body.classList.contains("stats-mode")).toBe(false);
  });

  it("shows only the stats view", () => {
    showPortfolioView();
    showStatsView();

    expect(state.currentView).toBe("stats");
    expect(visibleViews()).toEqual(["stats-view"]);
    expect(activeViews()).toEqual(["stats"]);
    expect(title()).toBe("Statistics");
    expect(document.body.classList.contains("stats-mode")).toBe(true);
    expect(document.body.classList.contains("portfolio-mode")).toBe(false);
  });

  it("drops both mode classes on the invoices view", () => {
    showStatsView();
    showInvoicesView();

    expect(state.currentView).toBe("invoices");
    expect(visibleViews()).toEqual(["invoices-view"]);
    expect(activeViews()).toEqual(["invoices"]);
    expect(title()).toBe("Invoices");
    expect(document.body.classList.contains("stats-mode")).toBe(false);
    expect(document.body.classList.contains("portfolio-mode")).toBe(false);
  });

  it("routes a nav click to the matching view", () => {
    setupViewListeners();

    document.querySelector('[data-view="portfolio"]').click();
    expect(state.currentView).toBe("portfolio");

    document.querySelector('[data-view="stats"]').click();
    expect(state.currentView).toBe("stats");

    document.querySelector('[data-view="invoices"]').click();
    expect(state.currentView).toBe("invoices");
  });

  it("ignores a nav item with an unknown view", () => {
    setupViewListeners();
    showPortfolioView();

    document.querySelector('[data-view="nonsense"]').click();

    expect(state.currentView).toBe("portfolio");
    expect(visibleViews()).toEqual(["portfolio-view"]);
  });
});
