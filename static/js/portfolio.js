/**
 * Portfolio view: fetching `GET /api/portfolio`, the persisted preferences and
 * the delegated listeners. The markup is built in `portfolio-render.js`.
 */

import {
  portfolioState,
  collapsedDepots,
  expandedPositions,
  PORTFOLIO_RANGES,
  PORTFOLIO_RANGE_STORAGE_KEY,
  PORTFOLIO_DEPOT_STORAGE_KEY,
  PORTFOLIO_POSITIONS_STORAGE_KEY,
  PORTFOLIO_MAX_LINES,
  positionLineColors,
} from "./state.js";
import { apiFetch } from "./http.js";
import { mobileViewport } from "./dom.js";
import { showErrorToast } from "./toast.js";
import { createDepotFilter, DEPOT_ALL } from "./portfolio-depot.js";
import {
  createPositionsFilter,
  POSITIONS_ALL,
} from "./portfolio-positions-filter.js";
import { assignLineColors } from "./portfolio-line-colors.js";
import { positionsListHtml, summaryCardsHtml } from "./portfolio-render.js";
import { renderPortfolioCharts } from "./portfolio-charts.js";
import { openHistoryModal } from "./portfolio-history.js";
import { refreshTruncation } from "./truncate.js";

let depotFilter = null;
// The last payload's position ids, used to prune stale expansions.
const positionIds = new Set();

// Kept so a position toggle redraws without refetching: the selection changes
// no server answer.
let positionsFilter = null;
let lastPayload = null;

// Only the very first load shows the spinner; a refetch keeps the list on screen.
let hasRendered = false;

/**
 * Restore the persisted period and depot filter before the first render.
 * Only the depot id's shape is checked here; `depotFilterIsStale()` catches the rest.
 */
export function restorePortfolioPrefs() {
  const range = localStorage.getItem(PORTFOLIO_RANGE_STORAGE_KEY);
  if (PORTFOLIO_RANGES.includes(range)) portfolioState.portfolioRange = range;

  const depot = localStorage.getItem(PORTFOLIO_DEPOT_STORAGE_KEY);
  if (depot === DEPOT_ALL || /^\d+$/.test(depot ?? ""))
    portfolioState.depotFilter = depot;

  portfolioState.portfolioPositions = storedPositionSelection();
  syncLineColors();
}

/** Re-derive the palette slots; mutated in place because other modules share the map. */
function syncLineColors() {
  const next = assignLineColors(
    positionLineColors,
    portfolioState.portfolioPositions,
  );
  positionLineColors.clear();
  next.forEach((slot, id) => positionLineColors.set(id, slot));
}

/**
 * Read the persisted chart selection, or "all" when it is absent or unusable.
 * Parsed defensively because the stored JSON may have been hand-edited.
 */
function storedPositionSelection() {
  const raw = localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY);
  if (!raw || raw === POSITIONS_ALL) return POSITIONS_ALL;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return POSITIONS_ALL;
    if (!parsed.every((id) => Number.isInteger(id))) return POSITIONS_ALL;
    // A hand-edited value may name more positions than the palette has colors.
    return parsed.slice(0, PORTFOLIO_MAX_LINES);
  } catch {
    return POSITIONS_ALL;
  }
}

/**
 * The stored selection narrowed to what this payload can draw.
 * Never written back: a missing id may merely sit outside the depot filter, so
 * a depot switch stays reversible.
 */
function visiblePositionSelection(payload) {
  if (portfolioState.portfolioPositions === POSITIONS_ALL) return POSITIONS_ALL;

  const available = new Set(
    (payload.series?.positions ?? []).map((entry) => entry.id),
  );
  const kept = portfolioState.portfolioPositions.filter((id) =>
    available.has(id),
  );
  return kept.length > 0 ? kept : POSITIONS_ALL;
}

/** The stored ids this payload cannot show. */
function hiddenPositionSelection(payload) {
  if (portfolioState.portfolioPositions === POSITIONS_ALL) return [];

  const available = new Set(
    (payload.series?.positions ?? []).map((entry) => entry.id),
  );
  return portfolioState.portfolioPositions.filter((id) => !available.has(id));
}

/**
 * Persist a selection and mirror its visible part in the control. The hidden
 * count is passed on because the palette limit spans the whole selection.
 */
function storePositionSelection(selection) {
  portfolioState.portfolioPositions = selection;
  syncLineColors();
  localStorage.setItem(
    PORTFOLIO_POSITIONS_STORAGE_KEY,
    selection === POSITIONS_ALL ? POSITIONS_ALL : JSON.stringify(selection),
  );
  if (positionsFilter && lastPayload)
    positionsFilter.setValue(visiblePositionSelection(lastPayload), {
      hidden: hiddenPositionSelection(lastPayload).length,
    });
}

function portfolioElements() {
  return {
    summary: document.querySelector('[data-el="portfolio-summary"]'),
    chartCard: document.querySelector('[data-el="portfolio-chart-card"]'),
    list: document.querySelector('[data-el="portfolio-list"]'),
    bottom: document.querySelector('[data-el="portfolio-bottom"]'),
    empty: document.querySelector('[data-el="portfolio-empty"]'),
  };
}

function showSections({ hasPositions }) {
  const { summary, chartCard, list, bottom, empty } = portfolioElements();
  [summary, chartCard, list, bottom].forEach((section) =>
    section?.classList.toggle("is-hidden", !hasPositions),
  );
  empty.classList.toggle("is-hidden", hasPositions);
  // Hides both snapshot triggers: without positions there is nothing to record.
  document.body.classList.toggle("portfolio-no-positions", !hasPositions);
}

/** Render a payload into the cards, the list and the charts. */
function renderPortfolio(payload) {
  const { summary, list } = portfolioElements();
  const depots = payload.depots ?? [];
  const renderPayload = { ...payload, depots };

  positionIds.clear();
  depots.forEach((depot) => {
    depot.positions.forEach((position) => positionIds.add(position.id));
  });

  // A vanished id would otherwise silently re-open later.
  const depotIds = new Set(depots.map((depot) => depot.id));
  collapsedDepots.forEach((id) => {
    if (!depotIds.has(id)) collapsedDepots.delete(id);
  });
  expandedPositions.forEach((id) => {
    if (!positionIds.has(id)) expandedPositions.delete(id);
  });

  // Not `totals.position_count`: it counts only held positions, so a fully sold
  // portfolio would show the empty state.
  showSections({
    hasPositions: depots.some((depot) => depot.positions.length > 0),
  });
  summary.innerHTML = summaryCardsHtml(renderPayload.totals);
  list.innerHTML = positionsListHtml(renderPayload, {
    collapsed: collapsedDepots,
    expanded: expandedPositions,
  });
  refreshTruncation(list);

  lastPayload = renderPayload;
  // Options before value: a single pick's label needs the position names.
  if (positionsFilter) {
    positionsFilter.setOptions(renderPayload.series?.positions ?? []);
    positionsFilter.setValue(visiblePositionSelection(renderPayload), {
      hidden: hiddenPositionSelection(renderPayload).length,
    });
  }

  renderPortfolioCharts(renderPayload);
  hasRendered = true;
}

/** Whether the persisted depot filter names a depot the payload lacks. */
function depotFilterIsStale(payload) {
  if (portfolioState.depotFilter === DEPOT_ALL) return false;
  return !(payload.depots ?? []).some(
    (depot) => String(depot.id) === portfolioState.depotFilter,
  );
}

function clearDepotFilter() {
  portfolioState.depotFilter = DEPOT_ALL;
  localStorage.removeItem(PORTFOLIO_DEPOT_STORAGE_KEY);
  if (depotFilter) depotFilter.setValue(DEPOT_ALL);
}

/**
 * Load and render the portfolio for the active period and depot filter.
 * `allowRetry` limits the stale-depot recovery to one retry, so it cannot spin.
 */
export async function loadPortfolio(allowRetry = true) {
  const { list } = portfolioElements();
  if (!list) return;

  const params = new URLSearchParams({ range: portfolioState.portfolioRange });
  if (portfolioState.depotFilter !== DEPOT_ALL)
    params.set("depot", portfolioState.depotFilter);

  if (!hasRendered) {
    list.classList.remove("is-hidden");
    list.innerHTML =
      '<div class="portfolio-loading"><div class="spinner"></div></div>';
  }

  let payload;
  try {
    const response = await apiFetch(`/api/portfolio?${params}`);
    // An unknown depot id is a 400; any other failure must leave the filter alone.
    if (
      response.status === 400 &&
      allowRetry &&
      portfolioState.depotFilter !== DEPOT_ALL
    ) {
      clearDepotFilter();
      await loadPortfolio(false);
      return;
    }
    // apiFetch resolves for any status.
    if (!response.ok)
      throw new Error(`Portfolio request failed: ${response.status}`);
    payload = await response.json();
  } catch (error) {
    console.error("Error loading portfolio:", error);
    if (!hasRendered) list.innerHTML = "";
    showErrorToast("Failed to load portfolio");
    return;
  }

  if (allowRetry && depotFilterIsStale(payload)) {
    clearDepotFilter();
    await loadPortfolio(false);
    return;
  }

  if (depotFilter) depotFilter.setOptions(payload.depot_options ?? []);
  renderPortfolio(payload);
}

function syncPeriodButtons() {
  document.querySelectorAll(".portfolio-period-btn").forEach((button) => {
    const active = button.dataset.range === portfolioState.portfolioRange;
    button.setAttribute("aria-pressed", String(active));
  });
}

/** Switch the period, persist it and reload; unknown tokens never reach storage. */
function setPortfolioRange(range) {
  if (!PORTFOLIO_RANGES.includes(range)) return;
  portfolioState.portfolioRange = range;
  localStorage.setItem(PORTFOLIO_RANGE_STORAGE_KEY, range);
  syncPeriodButtons();
  loadPortfolio();
}

function setDepotFilter(depot) {
  portfolioState.depotFilter = depot;
  localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, depot);
  loadPortfolio();
}

/** Switch which positions the chart draws; no refetch, the payload has every line. */
function setPortfolioPositions(selection, toggled) {
  storePositionSelection(mergedPositionSelection(selection, toggled));
  if (lastPayload) renderPortfolioCharts(lastPayload);
}

/**
 * Merge a toggle of the visible rows into the stored selection, keeping the ids
 * the depot filter hides; the "all" row (`toggled === null`) clears them too.
 * The slice is a backstop for a hand-edited store; visible ids go first so no
 * checked row ends up colourless.
 */
function mergedPositionSelection(selection, toggled) {
  if (toggled === null || !lastPayload) return selection;

  const visible = selection === POSITIONS_ALL ? [] : selection;
  const merged = [...visible, ...hiddenPositionSelection(lastPayload)];
  if (merged.length === 0) return POSITIONS_ALL;
  return merged.slice(0, PORTFOLIO_MAX_LINES);
}

function toggleDepotGroup(header) {
  const group = header.closest(".portfolio-group");
  const id = Number(group.dataset.depotId);
  const collapsed = group.classList.toggle("is-collapsed");
  header.setAttribute("aria-expanded", String(!collapsed));
  // The collapsed body is only zero-height, so inert keeps its rows unreachable.
  group.querySelector(".portfolio-group-body").inert = collapsed;
  if (collapsed) collapsedDepots.add(id);
  else collapsedDepots.delete(id);
}

/**
 * Reveal or hide a position's detail strip. The strip is never inserted or
 * removed, so the row's `aria-controls` always resolves.
 */
function togglePositionRow(row) {
  const detail = row.nextElementSibling;
  if (!detail || !detail.classList.contains("portfolio-detail")) return;

  const open = detail.classList.toggle("is-open");
  row.setAttribute("aria-expanded", String(open));
  // A closed strip is only zero-height, so inert keeps it out of the tab order.
  detail.inert = !open;

  const id = Number(row.dataset.positionId);
  if (open) expandedPositions.add(id);
  else expandedPositions.delete(id);
}

/** Wire the portfolio toolbar and list (delegated: their contents are rendered at runtime). */
export function setupPortfolioListeners() {
  const period = document.querySelector('[data-el="portfolio-period"]');
  if (!period) return;

  period.addEventListener("click", (event) => {
    const button = event.target.closest(".portfolio-period-btn");
    if (button) setPortfolioRange(button.dataset.range);
  });

  // Tick budget and label format are sampled per render; Chart.js only resizes.
  mobileViewport.addEventListener("change", () => {
    if (lastPayload) renderPortfolioCharts(lastPayload);
  });

  const depotRoot = document.querySelector('[data-el="portfolio-depot"]');
  if (depotRoot) {
    depotFilter = createDepotFilter(depotRoot, { onChange: setDepotFilter });
    depotFilter.setValue(portfolioState.depotFilter);
  }

  const positionsRoot = document.querySelector(
    '[data-el="portfolio-positions"]',
  );
  if (positionsRoot) {
    positionsFilter = createPositionsFilter(positionsRoot, {
      onChange: setPortfolioPositions,
    });
    // The hidden count needs a payload; the first render supplies it.
    positionsFilter.setValue(portfolioState.portfolioPositions);
  }

  const list = document.querySelector('[data-el="portfolio-list"]');
  if (list) {
    list.addEventListener("click", (event) => {
      const header = event.target.closest(".portfolio-group-header");
      if (header) {
        toggleDepotGroup(header);
        return;
      }
      // Checked before the row, so the trigger never doubles as a collapse.
      const history = event.target.closest('[data-action="show-history"]');
      if (history) {
        openHistoryModal(
          Number(history.dataset.positionId),
          history.dataset.positionName,
        );
        return;
      }
      const row = event.target.closest(".portfolio-row");
      if (row) togglePositionRow(row);
    });
  }

  // The markup ships with 1Y active; a restored preference may say otherwise.
  syncPeriodButtons();
}
