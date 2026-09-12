/**
 * Server I/O for the invoice list and the store/category filter dropdowns.
 */

import { state, selectedInvoices } from "./state.js";
import { els, getSearchValue } from "./dom.js";
import { showErrorToast, commitPendingToast, hideUndoToast } from "./toast.js";
import { renderInvoices } from "./render.js";
import { loadStats } from "./stats.js";
import { getCombobox, setCategoryOptions } from "./combobox.js";
import { updateFilterBadge } from "./filters.js";
import { apiFetch } from "./http.js";

// Cancels the in-flight invoice request when a newer one supersedes it, so a
// slower earlier response can't render over a newer one (out-of-order results
// on rapid filter/search/sort/pagination changes).
let inFlightController = null;

/**
 * Reload the invoice list plus the store and category lookups in one call.
 */
export function refreshAllData() {
  loadInvoices();
  loadStores();
  loadCategories();
}

/**
 * Load the invoice list, resetting to the first page. Use this for any filter,
 * search, sort or post-mutation refresh; use `goToPage` for pagination.
 */
export async function loadInvoices() {
  // A new query invalidates the selection: clearing here (but not in goToPage /
  // reloadCurrentPage) drops out-of-view ids on filter/search/sort/period
  // changes while preserving cross-page "select all" within a fixed filter set.
  selectedInvoices.clear();
  state.page = 1;
  await fetchInvoices();
}

/**
 * Load a specific invoice-list page without touching the active filters.
 */
export async function goToPage(page) {
  state.page = page;
  await fetchInvoices();
}

/**
 * Reload the current page after a mutation, preserving the user's position.
 * If a deletion emptied the current page, step back to the last page with rows.
 */
export async function reloadCurrentPage() {
  await fetchInvoices();
  const totalPages = Math.max(
    1,
    Math.ceil(state.totalCount / state.effectivePageSize),
  );
  if (state.page > totalPages) {
    state.page = totalPages;
    await fetchInvoices();
  }
}

/**
 * Assemble the active filter/search/sort params shared by the list endpoint and
 * the filtered-ids endpoint, so both always see the same query.
 */
export function buildFilterParams() {
  const { storeFilter, typeFilter, dateFrom, dateTo, sortBy, sortOrder } =
    els();
  return new URLSearchParams({
    search: getSearchValue(),
    store: storeFilter.value,
    category: typeFilter.value,
    date_from: dateFrom.value,
    date_to: dateTo.value,
    sort_by: sortBy.value,
    sort_order: sortOrder.value,
  });
}

/**
 * Fetch the ids of every invoice matching the active filters (all pages).
 * Backs cross-page "select all".
 */
export async function fetchFilteredIds() {
  const response = await apiFetch(`/api/invoices/ids?${buildFilterParams()}`);
  const data = await response.json();
  return data.ids;
}

/**
 * Fetch a single invoice's line items on demand. The compact list endpoint no
 * longer ships items, so this backs both row expansion and the edit dialog.
 * Throws on a failed request; callers handle the error.
 */
export async function fetchInvoiceItems(id) {
  const response = await apiFetch(`/api/invoices/${id}`);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  const data = await response.json();
  return data.items;
}

async function fetchInvoices() {
  // Finalize any deferred delete/edit before reloading from the server, so a
  // pending row (still present server-side until commit) can't reappear in the
  // fresh list. commitPendingToast() nulls its callback first, so the reload it
  // triggers re-enters here harmlessly. When this reload was triggered by
  // something other than the action's own commit (a filter change, or an
  // overlapping action's commit), the toast is now stale — hide it so its Undo
  // can't restore a snapshot that no longer matches the view or the server.
  if (commitPendingToast()) hideUndoToast();

  const params = buildFilterParams();
  params.set("page", state.page);
  params.set("page_size", state.pageSize);

  inFlightController?.abort();
  const controller = new AbortController();
  inFlightController = controller;

  try {
    const response = await apiFetch(`/api/invoices?${params}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    state.invoices = data.invoices;
    state.page = data.page;
    state.effectivePageSize = data.page_size;
    state.totalCount = data.total_count;
    state.totalSum = data.total_sum;
    renderInvoices();

    // Also refresh stats if in stats view
    if (state.currentView === "stats") {
      loadStats();
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    showErrorToast("Failed to load invoices");
  } finally {
    if (inFlightController === controller) inFlightController = null;
  }
}

/**
 * Wire the pagination control via event delegation on its stable container.
 */
export function setupPaginationListeners() {
  const container = document.querySelector('[data-el="pagination"]');
  if (!container) return;

  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    if (button.dataset.action === "page-prev") goToPage(state.page - 1);
    else if (button.dataset.action === "page-next") goToPage(state.page + 1);
  });
}

export async function loadStores() {
  try {
    const storeFilter = getCombobox("store-filter");
    const previousValue = storeFilter ? storeFilter.getValue() : "";

    const response = await apiFetch("/api/stores");
    const stores = await response.json();

    if (storeFilter) storeFilter.setOptions(stores);

    // Restore filter or jump to next store if previous one no longer exists
    if (storeFilter && previousValue) {
      if (stores.includes(previousValue)) {
        storeFilter.setValue(previousValue);
      } else if (stores.length > 0) {
        // Find next store alphabetically, or last one if none found
        const nextStore =
          stores.find((s) => s > previousValue) || stores[stores.length - 1];
        storeFilter.setValue(nextStore);
        loadInvoices();
      } else {
        // No stores left at all: clear the stale selection.
        storeFilter.setValue("");
        updateFilterBadge();
        loadInvoices();
      }
    }
  } catch (error) {
    console.error("Error loading stores:", error);
  }
}

export async function loadCategories() {
  try {
    const typeFilter = getCombobox("type-filter");
    const previousValue = typeFilter ? typeFilter.getValue() : "";

    const response = await apiFetch("/api/categories");
    const categories = await response.json();

    // Feed the fresh option list to every category combobox (filter + modals).
    setCategoryOptions(categories);

    // Clear the filter and reload if its selected category no longer exists.
    if (typeFilter && previousValue && !categories.includes(previousValue)) {
      typeFilter.setValue("");
      updateFilterBadge();
      loadInvoices();
    }
  } catch (error) {
    console.error("Error loading categories:", error);
  }
}
