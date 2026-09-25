/**
 * Date-range filtering and period navigation (week/month/year/all/custom),
 * including the ISO-week date helpers used only here.
 */

import { invoiceState } from "./state.js";
import { els, debounce, dateToIso, capAtToday } from "./dom.js";
import { loadInvoices } from "./api.js";
import { getCombobox } from "./combobox.js";

// Apply a specific filter mode
export function applyFilter(mode) {
  invoiceState.filterMode = mode;
  invoiceState.currentDate = new Date();
  updateFilterDisplay();
  setDateFiltersForMode();
  updateQuickFilterButtons();
  updateFilterBadge();
}

// Navigate to previous period based on filter mode
export function navigateToPrevious() {
  if (invoiceState.filterMode === "all" || invoiceState.filterMode === "custom")
    return;

  switch (invoiceState.filterMode) {
    case "week":
      invoiceState.currentDate.setDate(invoiceState.currentDate.getDate() - 7);
      break;
    case "month":
      invoiceState.currentDate.setMonth(
        invoiceState.currentDate.getMonth() - 1,
      );
      break;
    case "year":
      invoiceState.currentDate.setFullYear(
        invoiceState.currentDate.getFullYear() - 1,
      );
      break;
  }
  updateFilterDisplay();
  setDateFiltersForMode();
  loadInvoices();
}

// Navigate to next period based on filter mode
export function navigateToNext() {
  if (invoiceState.filterMode === "all" || invoiceState.filterMode === "custom")
    return;
  if (isViewingCurrentPeriod()) return;

  switch (invoiceState.filterMode) {
    case "week":
      invoiceState.currentDate.setDate(invoiceState.currentDate.getDate() + 7);
      break;
    case "month":
      invoiceState.currentDate.setMonth(
        invoiceState.currentDate.getMonth() + 1,
      );
      break;
    case "year":
      invoiceState.currentDate.setFullYear(
        invoiceState.currentDate.getFullYear() + 1,
      );
      break;
  }
  updateFilterDisplay();
  setDateFiltersForMode();
  loadInvoices();
}

// Reset to current period for active filter mode
export function resetToCurrent() {
  invoiceState.currentDate = new Date();
  updateFilterDisplay();
  setDateFiltersForMode();
  loadInvoices();
}

// Reset all filters back to defaults (current month, no search/store/category)
export function resetAllFilters() {
  const { searchInput, sortBy, sortOrder } = els();

  searchInput.value = "";
  getCombobox("store-filter").setValue("");
  getCombobox("type-filter").setValue("");
  sortBy.value = "date";
  sortOrder.value = "desc";
  resetSortPills();

  // Reset to current month (also recomputes the filter badge)
  applyFilter("month");
  loadInvoices();
}

// Restore the sort/order pill groups to their default active pills.
function resetSortPills() {
  document.querySelectorAll(".pill-group .pill").forEach((pill) => {
    const isDefault =
      pill.dataset.sort === "date" || pill.dataset.order === "desc";
    pill.classList.toggle("active", isDefault);
  });
}

/**
 * Wire the quick-filter buttons, period navigation and the advanced filter
 * inputs, plus the mobile/desktop search field synchronization.
 */
export function setupFilterListeners() {
  // Quick filters: dispatch by the button's data-filter value
  document
    .querySelector(".quick-filters")
    .addEventListener("click", (event) => {
      const button = event.target.closest(".quick-filter-btn");
      if (!button) return;
      applyFilter(button.dataset.filter);
      loadInvoices();
    });

  // Period navigation
  document
    .querySelector('[data-action="nav-prev"]')
    .addEventListener("click", navigateToPrevious);
  document
    .querySelector('[data-action="nav-next"]')
    .addEventListener("click", navigateToNext);
  document
    .querySelector('[data-action="nav-today"]')
    .addEventListener("click", resetToCurrent);
  document
    .querySelector('[data-action="reset-filters"]')
    .addEventListener("click", resetAllFilters);

  // Advanced filter inputs. The store and category controls are comboboxes
  // whose selection callbacks (wired in app.js) already reload and update the
  // badge.
  const { searchInput, dateFrom, dateTo } = els();

  searchInput.addEventListener("input", debounce(loadInvoices, 300));
  // Cap both date pickers at today — there are no future invoices to filter for
  // (`capAtToday` shifts that to tomorrow on Firefox for Android, which is
  // harmless here: a future end date simply matches no extra rows).
  // These inputs stay mounted, so also refresh `max` on focus: a session left
  // open across midnight would otherwise cap at yesterday until reload.
  capAtToday(dateFrom);
  capAtToday(dateTo);
  dateFrom.addEventListener("focus", () => capAtToday(dateFrom));
  dateTo.addEventListener("focus", () => capAtToday(dateTo));

  // Manually changing a date filter switches to custom mode
  dateFrom.addEventListener("change", switchToCustomMode);
  dateTo.addEventListener("change", switchToCustomMode);

  setupSortPills();
  setupToolbarSearch();
  updateFilterBadge();
}

/**
 * Width an inline search field would get, from already-measured toolbar parts.
 *
 * Pure: the caller measures, this one decides — which is also what makes the
 * gap arithmetic testable without a layout engine. `aiPresent` and `aiWidth`
 * are separate inputs because presence is a DOM fact and width a measurement: a
 * trigger that measures 0 (not laid out yet) still occupies its inter-item gap,
 * so deriving absence from a zero width would drop a gap the row still has.
 */
export function searchFieldSpace({
  rowWidth,
  wrapped,
  aiPresent,
  aiWidth,
  filterWidth,
  quickFloor,
  monthWidth,
  todayWidth,
  rowGap,
}) {
  // The AI trigger is one flex item inside the group, so its absence (AI
  // suggestions disabled) also removes one inter-item gap from both layouts.
  const aiGapCount = aiPresent ? 1 : 0;
  // Wrapped: flex-wrap has dropped the group onto its own second row, where it
  // shares the width only with Filter and — when present — AI.
  if (wrapped) {
    return rowWidth - aiWidth - filterWidth - rowGap * (1 + aiGapCount);
  }
  // Single row: the field's share is the row minus the fixed chips, with the
  // pills shrunk to their min-width floor. The gap count ≈ the inline layout's
  // inter-item gaps (4 row items + 2 group gaps, one fewer group gap without
  // the AI trigger); the hysteresis band absorbs the minor variance when the
  // today button is display:none'd (all/custom).
  const fixed = quickFloor + monthWidth + todayWidth + aiWidth + filterWidth;
  return rowWidth - fixed - rowGap * (4 + aiGapCount);
}

/**
 * Two-state toolbar search (12a), desktop only: the field is either a full
 * inline input or — when the toolbar is tight — a persistent icon button that
 * toggles a slide-down bar in its own full-width row below the toolbar
 * (mirroring the mobile search). A ResizeObserver on the toolbar switches
 * states by the width actually left for the field; at <= 640px the mobile
 * slide-in (drawer.js) owns the search.
 */
function setupToolbarSearch() {
  const row = document.querySelector(".filters-row");
  const group = document.querySelector(".search-filter-group");
  const quickFilters = document.querySelector(".quick-filters");
  const monthNavigator = document.querySelector(".month-navigator");
  const todayButton = document.querySelector('[data-action="nav-today"]');
  const toggleButton = document.querySelector(
    '[data-el="search-toggle-compact"]',
  );
  const aiTrigger = document.querySelector('[data-el="ai-categories-trigger"]');
  const filterButton = document.querySelector('[data-el="filters-toggle"]');
  const closeButton = document.querySelector('[data-el="search-close"]');
  const { searchInput } = els();

  // Empirical tuning constants, coupled to the toolbar's inline layout — the
  // thing to re-tune if a toolbar item is added or resized. collapseBelow and
  // expandAbove straddle a 50px hysteresis band (expandAbove - collapseBelow)
  // that stops the field flickering between states at the threshold.
  const rowGap = 8; // .filters-row column gap
  const collapseBelow = 210; // box width under which the input is unusable
  const expandAbove = 260; // re-expand only past this (hysteresis band top)
  const closeAnimationMs = 200; // keep in sync with --transition (0.2s)
  let closeRowTimer = null;

  const clearCloseRowTimer = () => {
    if (closeRowTimer === null) return;
    clearTimeout(closeRowTimer);
    closeRowTimer = null;
  };

  const finishClosing = (restoreFocus = false) => {
    clearCloseRowTimer();
    group.classList.remove("search-closing");
    group.classList.remove("search-open");
    toggleButton.setAttribute("aria-expanded", "false");
    if (restoreFocus && group.classList.contains("search-compact")) {
      toggleButton.focus();
    }
  };

  // restoreFocus returns focus to the toggle button after an explicit close
  // (Esc, ✕, second toggle click) so keyboard users are not stranded.
  const closeSearchRow = (restoreFocus = false, immediate = false) => {
    if (
      !group.classList.contains("search-open") &&
      !group.classList.contains("search-closing")
    ) {
      return;
    }

    if (immediate) {
      finishClosing(restoreFocus);
      return;
    }

    clearCloseRowTimer();
    group.classList.add("search-closing");
    toggleButton.setAttribute("aria-expanded", "false");
    closeRowTimer = setTimeout(() => {
      finishClosing(restoreFocus);
    }, closeAnimationMs);
  };

  const openSearchRow = () => {
    clearCloseRowTimer();
    group.classList.remove("search-closing");
    group.classList.add("search-open");
    toggleButton.setAttribute("aria-expanded", "true");
    searchInput.focus();
  };

  // Field-box width an inline search would get, measured against the group's
  // *current* row. Row-based, so it is independent of the group's flex state
  // (compact = flex:none, inline = flex:1) — which also removes a source of
  // expand/collapse oscillation.
  const availableForSearch = () =>
    searchFieldSpace({
      rowWidth: row.clientWidth,
      // Measure the wrapped row — not the single-row layout — or the field stays
      // needlessly collapsed to an icon on a near-empty line. filterButton always
      // has a box (never display:contents), so it is the state-independent probe.
      wrapped: filterButton.offsetTop > quickFilters.offsetTop + 2,
      aiPresent: Boolean(aiTrigger),
      aiWidth: aiTrigger ? aiTrigger.offsetWidth : 0,
      filterWidth: filterButton.offsetWidth,
      quickFloor: parseFloat(getComputedStyle(quickFilters).minWidth) || 0,
      monthWidth: monthNavigator.offsetWidth,
      todayWidth: todayButton.offsetWidth, // 0 when .is-hidden (all/custom)
      rowGap,
    });

  const syncState = () => {
    if (window.innerWidth <= 640) {
      group.classList.remove("search-compact");
      closeSearchRow(false, true);
      return;
    }
    const compact = group.classList.contains("search-compact");
    const available = availableForSearch();
    if (compact && available > expandAbove) {
      group.classList.remove("search-compact");
      closeSearchRow(false, true);
    } else if (!compact && available < collapseBelow) {
      group.classList.add("search-compact");
    }
  };

  toggleButton.addEventListener("click", () => {
    if (group.classList.contains("search-open")) {
      closeSearchRow(true);
    } else {
      openSearchRow();
    }
  });
  closeButton.addEventListener("click", () => closeSearchRow(true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearchRow(true);
  });

  // Observe the AI trigger too: its badge shows the uncategorized count, which
  // arrives asynchronously and grows the button (0 -> 12 -> 137) without
  // changing the row's own size — so observing the row alone would miss it.
  // It is absent entirely when AI suggestions are disabled (the template omits
  // it), and observe() throws on null — which would abort init() in app.js.
  const observer = new ResizeObserver(syncState);
  observer.observe(row);
  if (aiTrigger) observer.observe(aiTrigger);
  syncState();
}

// Sort/order are rendered as pill groups backed by hidden inputs (data-el
// sort-by / sort-order) so the shared buildFilterParams reader is unchanged.
function setupSortPills() {
  document.querySelectorAll(".pill-group").forEach((group) => {
    group.addEventListener("click", (event) => {
      const pill = event.target.closest(".pill");
      if (!pill) return;

      const { sortBy, sortOrder } = els();
      if (pill.dataset.sort) sortBy.value = pill.dataset.sort;
      if (pill.dataset.order) sortOrder.value = pill.dataset.order;

      group
        .querySelectorAll(".pill")
        .forEach((p) => p.classList.toggle("active", p === pill));
      loadInvoices();
    });
  });
}

/**
 * Update the Filter button badge with the count of active non-default filters
 * (store, category, and a custom date range).
 */
export function updateFilterBadge() {
  const { storeFilter, typeFilter } = els();
  let count = 0;
  if (storeFilter.value) count += 1;
  if (typeFilter.value) count += 1;
  if (invoiceState.filterMode === "custom") count += 1;

  const badge = document.querySelector('[data-el="filter-badge"]');
  if (!badge) return;
  badge.textContent = count;
  badge.hidden = count === 0;
}

// Switch to custom filter mode when a date input is edited directly
function switchToCustomMode() {
  if (invoiceState.filterMode !== "custom") {
    invoiceState.filterMode = "custom";
    updateFilterDisplay();
    updateQuickFilterButtons();
    updateFilterBadge();
  }
  loadInvoices();
}

// Update the navigation display based on filter mode
export function updateFilterDisplay() {
  const { monthDisplay } = els();
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const navButtons = document.querySelectorAll(".month-nav-btn");
  const todayBtn = document.querySelector('[data-action="nav-today"]');
  const nextBtn = document.querySelector('[data-action="nav-next"]');

  switch (invoiceState.filterMode) {
    case "week": {
      const weekNum = getISOWeek(invoiceState.currentDate);
      const weekYear = getISOWeekYear(invoiceState.currentDate);
      monthDisplay.textContent = `W${weekNum} / ${weekYear}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      break;
    }
    case "month": {
      const monthName = monthNames[invoiceState.currentDate.getMonth()];
      const year = invoiceState.currentDate.getFullYear();
      monthDisplay.textContent = `${monthName} ${year}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      break;
    }
    case "year":
      monthDisplay.textContent = `${invoiceState.currentDate.getFullYear()}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      break;
    case "all":
      monthDisplay.textContent = "All Invoices";
      navButtons.forEach((btn) => (btn.style.visibility = "hidden"));
      break;
    case "custom":
      monthDisplay.textContent = "Custom";
      navButtons.forEach((btn) => (btn.style.visibility = "hidden"));
      break;
  }

  // The jump-to-today button is hidden only where navigation is meaningless
  // (all/custom); otherwise it stays visible but disabled on the current period.
  const navigationActive =
    invoiceState.filterMode !== "all" && invoiceState.filterMode !== "custom";
  todayBtn.classList.toggle("is-hidden", !navigationActive);
  // The forward arrow stops at the current period — there are no future invoices.
  nextBtn.disabled = navigationActive && isViewingCurrentPeriod();
  if (navigationActive) {
    todayBtn.disabled = isViewingCurrentPeriod();
  }
}

// Whether invoiceState.currentDate falls in the same period as today for the active mode
function isViewingCurrentPeriod() {
  const today = new Date();
  switch (invoiceState.filterMode) {
    case "week":
      return (
        getISOWeek(invoiceState.currentDate) === getISOWeek(today) &&
        getISOWeekYear(invoiceState.currentDate) === getISOWeekYear(today)
      );
    case "month":
      return (
        invoiceState.currentDate.getMonth() === today.getMonth() &&
        invoiceState.currentDate.getFullYear() === today.getFullYear()
      );
    case "year":
      return invoiceState.currentDate.getFullYear() === today.getFullYear();
    default:
      return true;
  }
}

// Update quick filter button active state
export function updateQuickFilterButtons() {
  const buttons = document.querySelectorAll(".quick-filter-btn");
  buttons.forEach((btn) => {
    const btnMode = btn.getAttribute("data-filter");
    btn.classList.toggle("active", btnMode === invoiceState.filterMode);
  });
}

// Set date filters based on current mode
function setDateFiltersForMode() {
  const { dateFrom, dateTo } = els();
  switch (invoiceState.filterMode) {
    case "week":
      setDateFiltersForWeek(invoiceState.currentDate);
      break;
    case "month":
      setDateFiltersForMonth(invoiceState.currentDate);
      break;
    case "year":
      setDateFiltersForYear(invoiceState.currentDate);
      break;
    case "all":
      dateFrom.value = "";
      dateTo.value = "";
      break;
    case "custom":
      // Don't change the date filters for custom mode
      break;
  }
}

// Calculate ISO week number (weeks start on Monday)
export function getISOWeek(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Get the year that the ISO week belongs to
export function getISOWeekYear(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}

// Get Monday of the week for a given date
export function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

// Set date filters for a week (Monday to Sunday)
function setDateFiltersForWeek(date) {
  const { dateFrom, dateTo } = els();
  const monday = getMonday(date);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  dateFrom.value = dateToIso(monday);
  dateTo.value = dateToIso(sunday);
}

// Set date filters for a month
function setDateFiltersForMonth(date) {
  const { dateFrom, dateTo } = els();
  const year = date.getFullYear();
  const month = date.getMonth();

  // First day of the month
  const firstDay = new Date(year, month, 1);
  const firstDayStr = dateToIso(firstDay);

  // Last day of the month
  const lastDay = new Date(year, month + 1, 0);
  const lastDayStr = dateToIso(lastDay);

  dateFrom.value = firstDayStr;
  dateTo.value = lastDayStr;
}

// Set date filters for a year
function setDateFiltersForYear(date) {
  const { dateFrom, dateTo } = els();
  const year = date.getFullYear();

  const firstDay = new Date(year, 0, 1);
  const lastDay = new Date(year, 11, 31);

  dateFrom.value = dateToIso(firstDay);
  dateTo.value = dateToIso(lastDay);
}
