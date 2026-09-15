/**
 * View switching between the three top-level areas (invoices, statistics,
 * portfolio).
 *
 * It lives in its own module rather than in any one view: each view module owns
 * only its own body and exposes a loader, and this router is the single place
 * that knows all three. That also keeps stats.js and portfolio.js free of
 * imports from one another.
 */

import { state } from "./state.js";
import { closeMobileSearch } from "./drawer.js";
import { loadStats } from "./stats.js";
import { loadPortfolio } from "./portfolio.js";

// Every view root, keyed by its `data-view` token. The router hides all of them
// and reveals one, so a new view cannot be forgotten in a sibling's show call.
const VIEW_ELEMENTS = new Map([
  ["invoices", "invoices-view"],
  ["stats", "stats-view"],
  ["portfolio", "portfolio-view"],
]);

// Body classes carrying the per-view chrome rules in filters.css and sidebar.css.
const BODY_CLASSES = new Map([
  ["stats", "stats-mode"],
  ["portfolio", "portfolio-mode"],
]);

/**
 * Reveal one view and put the shell (body class, topbar title, sidebar nav) in
 * the matching state.
 */
function setView(name, title) {
  state.currentView = name;

  for (const [view, className] of BODY_CLASSES) {
    document.body.classList.toggle(className, view === name);
  }
  for (const [view, hook] of VIEW_ELEMENTS) {
    const element = document.querySelector(`[data-el="${hook}"]`);
    if (element) element.classList.toggle("is-hidden", view !== name);
  }

  document.querySelector('[data-el="topbar-title"]').textContent = title;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
  });
}

/**
 * Switch to the invoices list view.
 */
export function showInvoicesView() {
  setView("invoices", "Invoices");
}

/**
 * Switch to the statistics view and load stats data.
 */
export function showStatsView() {
  setView("stats", "Statistics");
  closeMobileSearch();
  loadStats();
}

/**
 * Switch to the portfolio view and load portfolio data.
 */
export function showPortfolioView() {
  setView("portfolio", "Portfolio");
  closeMobileSearch();
  loadPortfolio();
}

const VIEWS = new Map([
  ["invoices", showInvoicesView],
  ["stats", showStatsView],
  ["portfolio", showPortfolioView],
]);

/**
 * Wire the sidebar navigation. Dispatch is by lookup rather than a chain of
 * conditionals, so an unrecognised `data-view` does nothing instead of falling
 * through to whichever view happens to be the default branch.
 */
export function setupViewListeners() {
  document.querySelector(".sidebar-nav").addEventListener("click", (event) => {
    const button = event.target.closest(".nav-item");
    if (!button) return;
    const show = VIEWS.get(button.dataset.view);
    if (show) show();
  });
}
