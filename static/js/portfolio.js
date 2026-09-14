/**
 * Portfolio view: the period switcher and (from here on) the rendering of
 * depots, positions and charts.
 */

import {
  state,
  PORTFOLIO_RANGES,
  PORTFOLIO_RANGE_STORAGE_KEY,
  PORTFOLIO_DEPOT_STORAGE_KEY,
} from "./state.js";

/**
 * Restore the persisted period and depot filter before the first render.
 *
 * The depot id cannot be checked against the real depots this early, so only
 * its shape is validated; the view falls back to "all" once it sees a payload
 * without that depot.
 */
export function restorePortfolioPrefs() {
  const range = localStorage.getItem(PORTFOLIO_RANGE_STORAGE_KEY);
  if (PORTFOLIO_RANGES.includes(range)) state.portfolioRange = range;

  const depot = localStorage.getItem(PORTFOLIO_DEPOT_STORAGE_KEY);
  if (depot === "all" || /^\d+$/.test(depot ?? "")) state.depotFilter = depot;
}

/**
 * Load and render the portfolio for the active period and depot filter.
 *
 * A deliberate no-op for now: the view ships as its empty state first, so the
 * navigation skeleton can land without the data layer. The fetch lands here.
 */
export function loadPortfolio() {}

/** Mark the pill matching the active period, clearing the others. */
function syncPeriodButtons() {
  document.querySelectorAll(".portfolio-period-btn").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.range === state.portfolioRange,
    );
  });
}

/**
 * Switch the portfolio period, persist it and reload. Unknown tokens are
 * ignored — the pills are the only caller, but the value ends up in
 * localStorage and must stay within the allowlist.
 */
function setPortfolioRange(range) {
  if (!PORTFOLIO_RANGES.includes(range)) return;
  state.portfolioRange = range;
  localStorage.setItem(PORTFOLIO_RANGE_STORAGE_KEY, range);
  syncPeriodButtons();
  loadPortfolio();
}

/**
 * Wire the portfolio toolbar. The period group is delegated because its pills
 * are static markup but the rest of the toolbar is not.
 */
export function setupPortfolioListeners() {
  const period = document.querySelector('[data-el="portfolio-period"]');
  if (!period) return;

  period.addEventListener("click", (event) => {
    const button = event.target.closest(".portfolio-period-btn");
    if (button) setPortfolioRange(button.dataset.range);
  });

  // The markup ships with 1Y active; a restored preference may say otherwise.
  syncPeriodButtons();
}
