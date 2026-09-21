/**
 * Portfolio view: loading `GET /api/portfolio` and driving the toolbar, the
 * summary cards and the grouped positions list.
 *
 * The markup itself is built in `portfolio-render.js`; this module owns the
 * fetching, the persisted preferences and the delegated listeners.
 */

import {
  state,
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

// The live depot dropdown, and the ids of the last rendered payload's positions —
// what the pruning below needs to drop expansions that no longer exist.
let depotFilter = null;
const positionIds = new Set();

// The chart's position filter, and the payload it was last drawn from. The
// selection changes no server answer, so a toggle redraws from this rather than
// refetching — which is also what keeps it instant.
let positionsFilter = null;
let lastPayload = null;

// A refetch keeps the current list on screen; only the very first load has
// nothing to show and gets the spinner.
let hasRendered = false;

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
  if (depot === DEPOT_ALL || /^\d+$/.test(depot ?? ""))
    state.depotFilter = depot;

  state.portfolioPositions = storedPositionSelection();
  syncLineColors();
}

/**
 * Re-derive the palette slots from the current selection.
 *
 * The map is mutated rather than replaced, because every other module holds the
 * same instance. A slot survives as long as its position stays selected, so
 * this is safe to call on every selection change.
 */
function syncLineColors() {
  const next = assignLineColors(positionLineColors, state.portfolioPositions);
  positionLineColors.clear();
  next.forEach((slot, id) => positionLineColors.set(id, slot));
}

/**
 * Read the persisted chart selection, or "all" when it is absent or unusable.
 *
 * The ids cannot be checked against the real positions this early, and never
 * are: `visiblePositionSelection()` intersects them per payload instead. Stored
 * JSON is parsed defensively because nothing stops a user from editing it.
 */
function storedPositionSelection() {
  const raw = localStorage.getItem(PORTFOLIO_POSITIONS_STORAGE_KEY);
  if (!raw || raw === POSITIONS_ALL) return POSITIONS_ALL;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return POSITIONS_ALL;
    if (!parsed.every((id) => Number.isInteger(id))) return POSITIONS_ALL;
    // Capped like a live toggle is: nothing stops a hand-edited value from
    // naming more positions than the palette has colors.
    return parsed.slice(0, PORTFOLIO_MAX_LINES);
  } catch {
    return POSITIONS_ALL;
  }
}

/**
 * The stored selection narrowed to what this payload can actually draw.
 *
 * Read-only on purpose. A position missing from the payload is either gone for
 * good (sold, deleted) or merely outside the active depot filter, and the two
 * are indistinguishable here — so neither is written back, and a depot switch
 * stays reversible. `positionLines()` applies the same intersection to the
 * lines, so the control and the chart can never disagree.
 */
function visiblePositionSelection(payload) {
  if (state.portfolioPositions === POSITIONS_ALL) return POSITIONS_ALL;

  const available = new Set(
    (payload.series?.positions ?? []).map((entry) => entry.id),
  );
  const kept = state.portfolioPositions.filter((id) => available.has(id));
  return kept.length > 0 ? kept : POSITIONS_ALL;
}

/** The other half of the split: the stored ids this payload cannot show. */
function hiddenPositionSelection(payload) {
  if (state.portfolioPositions === POSITIONS_ALL) return [];

  const available = new Set(
    (payload.series?.positions ?? []).map((entry) => entry.id),
  );
  return state.portfolioPositions.filter((id) => !available.has(id));
}

/**
 * Persist a selection and mirror the part of it this payload can show.
 *
 * Only a deliberate toggle gets here: what a payload happens to carry never
 * rewrites the stored list. The control is fed the visible slice rather than
 * `selection` itself, because an id it has no row for would still count
 * towards its line limit and its "N positions" label.
 */
function storePositionSelection(selection) {
  state.portfolioPositions = selection;
  syncLineColors();
  localStorage.setItem(
    PORTFOLIO_POSITIONS_STORAGE_KEY,
    selection === POSITIONS_ALL ? POSITIONS_ALL : JSON.stringify(selection),
  );
  if (positionsFilter && lastPayload)
    positionsFilter.setValue(visiblePositionSelection(lastPayload));
}

/** The containers the view toggles between its loading, empty and data states. */
function portfolioElements() {
  return {
    summary: document.querySelector('[data-el="portfolio-summary"]'),
    chartCard: document.querySelector('[data-el="portfolio-chart-card"]'),
    list: document.querySelector('[data-el="portfolio-list"]'),
    bottom: document.querySelector('[data-el="portfolio-bottom"]'),
    empty: document.querySelector('[data-el="portfolio-empty"]'),
  };
}

/**
 * Show the empty state, or the data sections, but never both.
 */
function showSections({ hasPositions }) {
  const { summary, chartCard, list, bottom, empty } = portfolioElements();
  [summary, chartCard, list, bottom].forEach((section) =>
    section?.classList.toggle("is-hidden", !hasPositions),
  );
  empty.classList.toggle("is-hidden", hasPositions);
  // A snapshot has nothing to record without positions, so both of its triggers
  // (toolbar button and mobile FAB) hang off this class — the empty state's own
  // "Add first position" is then the single way in.
  document.body.classList.toggle("portfolio-no-positions", !hasPositions);
}

/**
 * Render a payload into the cards and the list, and record its position ids so
 * a vanished one cannot keep a stale expansion alive.
 */
function renderPortfolio(payload) {
  const { summary, list } = portfolioElements();

  positionIds.clear();
  payload.depots.forEach((depot) => {
    depot.positions.forEach((position) => positionIds.add(position.id));
  });

  // A depot or position that disappeared (filter change, sale) must not keep a
  // stale id alive in either set, where it would silently re-open later.
  const depotIds = new Set(payload.depots.map((depot) => depot.id));
  collapsedDepots.forEach((id) => {
    if (!depotIds.has(id)) collapsedDepots.delete(id);
  });
  expandedPositions.forEach((id) => {
    if (!positionIds.has(id)) expandedPositions.delete(id);
  });

  // Not `totals.position_count` — that counts only what is still held, so a
  // fully sold portfolio would hide its own rows and realized gain behind the
  // first-run empty state.
  showSections({
    hasPositions: payload.depots.some((depot) => depot.positions.length > 0),
  });
  summary.innerHTML = summaryCardsHtml(payload.totals);
  list.innerHTML = positionsListHtml(payload, {
    collapsed: collapsedDepots,
    expanded: expandedPositions,
  });

  lastPayload = payload;
  // Options before value: a single pick's label is the position's name, which
  // can only be resolved once the control knows this payload's positions.
  if (positionsFilter) {
    positionsFilter.setOptions(payload.series?.positions ?? []);
    positionsFilter.setValue(visiblePositionSelection(payload));
  }

  renderPortfolioCharts(payload);
  hasRendered = true;
}

/**
 * Whether the persisted depot filter still names a depot the server knows.
 *
 * `restorePortfolioPrefs()` can only validate the *shape* of a stored id; this
 * is where a deleted or renumbered depot is actually caught.
 */
function depotFilterIsStale(payload) {
  if (state.depotFilter === DEPOT_ALL) return false;
  return !payload.depots.some(
    (depot) => String(depot.id) === state.depotFilter,
  );
}

/** Drop a depot filter the server does not recognise, both in state and storage. */
function clearDepotFilter() {
  state.depotFilter = DEPOT_ALL;
  localStorage.removeItem(PORTFOLIO_DEPOT_STORAGE_KEY);
  if (depotFilter) depotFilter.setValue(DEPOT_ALL);
}

/**
 * Load and render the portfolio for the active period and depot filter.
 *
 * `allowRetry` guards the one recovery this function performs: a stored depot
 * the server rejects is cleared and the load repeated exactly once, so a
 * permanently unknown id cannot spin.
 */
export async function loadPortfolio(allowRetry = true) {
  const { list } = portfolioElements();
  if (!list) return;

  const params = new URLSearchParams({ range: state.portfolioRange });
  if (state.depotFilter !== DEPOT_ALL) params.set("depot", state.depotFilter);

  if (!hasRendered) {
    list.classList.remove("is-hidden");
    list.innerHTML =
      '<div class="portfolio-loading"><div class="spinner"></div></div>';
  }

  let payload;
  try {
    const response = await apiFetch(`/api/portfolio?${params}`);
    // The server rejects an unknown depot id with a 400 rather than widening
    // the filter, so the stale-filter recovery has to run from here too. Any
    // other failure is transient and must leave the persisted filter alone.
    if (
      response.status === 400 &&
      allowRetry &&
      state.depotFilter !== DEPOT_ALL
    ) {
      clearDepotFilter();
      await loadPortfolio(false);
      return;
    }
    // apiFetch resolves for any status, so `ok` is checked here rather than
    // letting an error body fall through as if it were a payload.
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

  if (depotFilter) depotFilter.setOptions(payload.depots);
  renderPortfolio(payload);
}

/** Mark the pill matching the active period, clearing the others. */
function syncPeriodButtons() {
  document.querySelectorAll(".portfolio-period-btn").forEach((button) => {
    const active = button.dataset.range === state.portfolioRange;
    button.setAttribute("aria-pressed", String(active));
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

/** Switch the depot filter, persist it and reload. */
function setDepotFilter(depot) {
  state.depotFilter = depot;
  localStorage.setItem(PORTFOLIO_DEPOT_STORAGE_KEY, depot);
  loadPortfolio();
}

/**
 * Switch which positions the chart draws, persist it and redraw.
 *
 * No refetch: the payload already carries a line per position, so the selection
 * is answered entirely from what is on screen.
 */
function setPortfolioPositions(selection, toggled) {
  storePositionSelection(mergedPositionSelection(selection, toggled));
  if (lastPayload) renderPortfolioCharts(lastPayload);
}

/**
 * What a toggle of the visible rows makes of the whole stored selection.
 *
 * A toggle edits only what was on screen: the ids the active depot filter hides
 * are carried across it, so switching back shows the lines again. The "all" row
 * is the exception — it is not a position but a reset, so it clears the hidden
 * ids too. The cap is the palette's, and the visible ids come first: an
 * oversized selection would spend slots on lines this payload cannot draw and
 * leave a checked row colourless.
 */
function mergedPositionSelection(selection, toggled) {
  if (toggled === null || !lastPayload) return selection;

  const visible = selection === POSITIONS_ALL ? [] : selection;
  const merged = [...visible, ...hiddenPositionSelection(lastPayload)];
  if (merged.length === 0) return POSITIONS_ALL;
  return merged.slice(0, PORTFOLIO_MAX_LINES);
}

/** Collapse or expand a depot group in place, without refetching. */
function toggleDepotGroup(header) {
  const group = header.closest(".portfolio-group");
  const id = Number(group.dataset.depotId);
  const collapsed = group.classList.toggle("is-collapsed");
  header.setAttribute("aria-expanded", String(!collapsed));
  // The collapsed body only shrinks to zero height, so without inert its rows
  // would stay tabbable and readable to a screen reader.
  group.querySelector(".portfolio-group-body").inert = collapsed;
  if (collapsed) collapsedDepots.add(id);
  else collapsedDepots.delete(id);
}

/**
 * Reveal or hide a position's detail strip.
 *
 * The strip is only opened and closed, never inserted or removed: the row's own
 * markup has to survive expanding untouched, and an always-present strip is what
 * keeps the row's `aria-controls` resolvable while collapsed.
 */
function togglePositionRow(row) {
  const detail = row.nextElementSibling;
  if (!detail || !detail.classList.contains("portfolio-detail")) return;

  const open = detail.classList.toggle("is-open");
  row.setAttribute("aria-expanded", String(open));
  // A closed strip is merely zero-height, so inert keeps it out of the tab
  // order and the accessibility tree the way `hidden` used to.
  detail.inert = !open;

  const id = Number(row.dataset.positionId);
  if (open) expandedPositions.add(id);
  else expandedPositions.delete(id);
}

/**
 * Wire the portfolio toolbar and list. Both are delegated because their
 * contents are rendered at runtime, while the containers are static markup.
 */
export function setupPortfolioListeners() {
  const period = document.querySelector('[data-el="portfolio-period"]');
  if (!period) return;

  period.addEventListener("click", (event) => {
    const button = event.target.closest(".portfolio-period-btn");
    if (button) setPortfolioRange(button.dataset.range);
  });

  // The chart samples the breakpoint once per render for its tick budget and
  // label format, so crossing 640px has to redraw: Chart.js resizes the canvas
  // by itself but re-derives neither.
  mobileViewport.addEventListener("change", () => {
    if (lastPayload) renderPortfolioCharts(lastPayload);
  });

  const depotRoot = document.querySelector('[data-el="portfolio-depot"]');
  if (depotRoot) {
    depotFilter = createDepotFilter(depotRoot, { onChange: setDepotFilter });
    depotFilter.setValue(state.depotFilter);
  }

  const positionsRoot = document.querySelector(
    '[data-el="portfolio-positions"]',
  );
  if (positionsRoot) {
    positionsFilter = createPositionsFilter(positionsRoot, {
      onChange: setPortfolioPositions,
    });
    positionsFilter.setValue(state.portfolioPositions);
  }

  const list = document.querySelector('[data-el="portfolio-list"]');
  if (list) {
    list.addEventListener("click", (event) => {
      const header = event.target.closest(".portfolio-group-header");
      if (header) {
        toggleDepotGroup(header);
        return;
      }
      // Checked before the row, even though the strip is the row's sibling: the
      // trigger must never double as a collapse.
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
