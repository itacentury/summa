/**
 * View switching between the three top-level areas (invoices, statistics,
 * portfolio).
 *
 * It lives in its own module rather than in any one view: each view module owns
 * only its own body and exposes a loader, and this router is the single place
 * that knows all three. That also keeps stats.js and portfolio.js free of
 * imports from one another.
 *
 * The URL hash is the single source of truth: a nav click only assigns
 * `location.hash`, and the `hashchange` handler does the switching. That makes a
 * reload land on the view the user was on, and it gets back/forward for free,
 * because the browser records a history entry per hash change. `setView()`
 * therefore must never write to the URL — doing so would re-enter this router
 * through its own event.
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

// The default view: what an absent or unrecognised hash falls back to, and the
// one the server-rendered markup already shows.
const DEFAULT_VIEW = "invoices";

/**
 * Show the view named by the URL hash, or the default one when it names nothing
 * known.
 *
 * Called once at boot and on every `hashchange`, so it is the only place a view
 * is entered outside a direct `show*()` call.
 */
export function applyViewFromHash() {
  const show = VIEWS.get(location.hash.slice(1)) ?? VIEWS.get(DEFAULT_VIEW);
  show();
}

/**
 * Wire the sidebar navigation and the hash listener.
 *
 * A click only assigns the hash; `applyViewFromHash` reacts to it. Dispatch is
 * by lookup rather than a chain of conditionals, so an unrecognised `data-view`
 * does nothing instead of falling through to whichever view happens to be the
 * default branch — and no junk token reaches the URL.
 */
export function setupViewListeners() {
  window.addEventListener("hashchange", applyViewFromHash);

  document.querySelector(".sidebar-nav").addEventListener("click", (event) => {
    const button = event.target.closest(".nav-item");
    if (!button) return;

    const view = button.dataset.view;
    if (!VIEWS.has(view)) return;

    // Re-clicking the active view leaves the hash untouched, so no `hashchange`
    // would fire; switch directly to keep a click on it a refresh, as it was
    // before the hash drove navigation.
    if (location.hash.slice(1) === view) {
      applyViewFromHash();
      return;
    }
    location.hash = view;
  });
}
