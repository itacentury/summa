/**
 * View switching between the three top-level areas.
 *
 * The contract under test is exclusivity: exactly one view root is visible, one
 * nav item is active, and the body carries at most one view-mode class. The
 * dispatch is covered too, because the listener it replaced routed every
 * unrecognised `data-view` to the invoices view.
 *
 * The hash is the second contract: it drives which view a reload lands on, so
 * an unknown or absent one must fall back rather than throw, and a nav click
 * must go through the URL instead of switching behind its back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyViewFromHash,
  setupViewListeners,
  showInvoicesView,
  showPortfolioView,
  showStatsView,
} from "../../static/js/views.js";
import { state } from "../../static/js/state.js";
import { loadInvoicesOnce } from "../../static/js/api.js";
import { loadStats } from "../../static/js/stats.js";
import { loadPortfolio } from "../../static/js/portfolio.js";

vi.mock("../../static/js/api.js", () => ({ loadInvoicesOnce: vi.fn() }));
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

// replaceState rather than `location.hash = ""` so no stray hashchange from the
// reset leaks into the next test.
const clearHash = () => history.replaceState(null, "", location.pathname);

// A nav click only assigns the hash; the switch happens in the hashchange
// handler, which fires asynchronously.
const clickNav = (view) =>
  new Promise((resolve) => {
    window.addEventListener("hashchange", resolve, { once: true });
    document.querySelector(`[data-view="${view}"]`).click();
  });

describe("view switching", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    document.body.className = "";
    state.currentView = "invoices";
    clearHash();
    vi.clearAllMocks();
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

  it("routes a nav click to the matching view through the hash", async () => {
    setupViewListeners();

    await clickNav("portfolio");
    expect(location.hash).toBe("#portfolio");
    expect(state.currentView).toBe("portfolio");

    await clickNav("stats");
    expect(location.hash).toBe("#stats");
    expect(state.currentView).toBe("stats");

    await clickNav("invoices");
    expect(location.hash).toBe("#invoices");
    expect(state.currentView).toBe("invoices");
  });

  it("ignores a nav item with an unknown view", () => {
    setupViewListeners();
    showPortfolioView();

    document.querySelector('[data-view="nonsense"]').click();

    expect(state.currentView).toBe("portfolio");
    expect(visibleViews()).toEqual(["portfolio-view"]);
    expect(location.hash).toBe("");
  });

  it("re-enters the active view when its nav item is clicked again", () => {
    setupViewListeners();
    location.hash = "#portfolio";

    // No hashchange fires here, so the click has to switch directly or the
    // view's loader would never re-run.
    document.querySelector('[data-view="portfolio"]').click();

    expect(state.currentView).toBe("portfolio");
    expect(visibleViews()).toEqual(["portfolio-view"]);
  });

  it("enters the view named by the hash", () => {
    location.hash = "#portfolio";

    applyViewFromHash();

    expect(state.currentView).toBe("portfolio");
    expect(visibleViews()).toEqual(["portfolio-view"]);
    expect(activeViews()).toEqual(["portfolio"]);
  });

  it("falls back to the invoices view on an absent hash", () => {
    showPortfolioView();

    applyViewFromHash();

    expect(state.currentView).toBe("invoices");
    expect(visibleViews()).toEqual(["invoices-view"]);
  });

  it("falls back to the invoices view on an unknown hash", () => {
    showPortfolioView();
    location.hash = "#nonsense";

    applyViewFromHash();

    expect(state.currentView).toBe("invoices");
    expect(visibleViews()).toEqual(["invoices-view"]);
  });

  // Each view loads its own data here and nowhere else, so booting into one
  // never fetches another's.
  it("loads only the entered view's data", () => {
    location.hash = "#portfolio";

    applyViewFromHash();

    expect(loadPortfolio).toHaveBeenCalledOnce();
    expect(loadInvoicesOnce).not.toHaveBeenCalled();
    expect(loadStats).not.toHaveBeenCalled();
  });

  it("loads the invoice list when its view is entered", () => {
    showStatsView();
    showInvoicesView();

    expect(loadInvoicesOnce).toHaveBeenCalledOnce();
  });
});
