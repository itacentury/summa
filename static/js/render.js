/**
 * Invoice list rendering and the bulk-action toolbar state.
 *
 * `updateBulkActionToolbar` lives here (rather than in bulk.js) because
 * renderInvoices calls it on every render and both write the same list DOM.
 * This module is deliberately not import-cycle-free: it forms cycles with
 * bulk.js, categorize.js, api.js and invoices.js. They are harmless — all of
 * those bindings are hoisted `export function` declarations that are only
 * called at runtime, never during module evaluation.
 */

import { invoiceState, selectedInvoices } from "./state.js";
import {
  els,
  escapeHtml,
  formatCurrency,
  formatDate,
  formatDateShort,
  applyCategoryBadge,
  withEuro,
} from "./dom.js";
import { editInvoice } from "./modals.js";
import { deleteInvoice } from "./invoices.js";
import { fetchInvoiceItems } from "./api.js";
import { toggleInvoiceSelection } from "./bulk.js";
import { updateAiTriggerBadge } from "./categorize.js";
import { renderPageSizeControl } from "./pagesize.js";

/**
 * Build the line-item rows for an invoice's expanded detail view. Shared by the
 * empty initial render and the lazy on-expand injection.
 */
export function itemRowsHtml(items) {
  return items
    .map(
      (item) => `
            <div class="item-row">
                <span class="item-name">${escapeHtml(item.item_name)}</span>
                <span class="item-price">${withEuro(
                  formatCurrency(item.item_price),
                )}</span>
            </div>
        `,
    )
    .join("");
}

/**
 * Capture rows about to be removed together with their positions, so a deferred
 * delete can splice them back at the same spots on undo/failure.
 * @param idSet ids of the rows being removed
 */
export function captureRows(idSet) {
  const rows = [];
  invoiceState.invoices.forEach((invoice, index) => {
    if (idSet.has(invoice.id)) rows.push({ invoice, index });
  });
  return rows;
}

/**
 * How many of `invoices` carry no category — the amount an optimistic mutation
 * has to take off `invoiceState.uncategorizedCount`.
 */
export function countUncategorized(invoices) {
  return invoices.filter((invoice) => !invoice.category).length;
}

/**
 * Apply a delta to the filter-wide uncategorized count, clamped at zero: the
 * count and the rows arrive in separate responses, so a change between them
 * could otherwise drive an optimistic adjustment negative. The clamp makes an
 * adjustment non-reversible (a subtraction that hit zero is given back in full
 * by the matching undo); that only happens when the count is already behind the
 * page, and the next `fetchInvoices` replaces the count outright.
 */
export function adjustUncategorizedCount(delta) {
  invoiceState.uncategorizedCount = Math.max(
    invoiceState.uncategorizedCount + delta,
    0,
  );
}

/**
 * Re-insert previously removed rows into the current list at their captured
 * positions and restore each row's count/sum/uncategorized contribution. An id
 * already present is skipped (a concurrent action kept it), so this composes
 * with another in-flight action instead of clobbering the whole list.
 * @param removed rows captured by `captureRows`
 * @param extraCount removed selected rows not visible on the page (bulk,
 *     off-page) whose sum was never subtracted — only their count is restored.
 *     Their categories were never known either, so they stay out of the
 *     uncategorized count exactly as they stayed out of the sum.
 */
export function reinsertRows(removed, extraCount = 0) {
  const reinserted = [];
  removed.forEach(({ invoice, index }) => {
    if (invoiceState.invoices.some((existing) => existing.id === invoice.id))
      return;
    invoiceState.invoices.splice(
      Math.min(index, invoiceState.invoices.length),
      0,
      invoice,
    );
    invoiceState.totalCount += 1;
    invoiceState.totalSum += Number(invoice.total);
    reinserted.push(invoice);
  });
  invoiceState.totalCount += extraCount;
  adjustUncategorizedCount(countUncategorized(reinserted));
  renderInvoices();
}

/**
 * Restore the pre-edit version of each row still present in the current list,
 * undoing its contribution to the uncategorized count along the way (an edit
 * can have added a category or cleared one). A row a concurrent action has
 * since removed is left gone, never resurrected — and its delta stays applied,
 * since that action accounted for the row in its post-edit shape.
 * @param previous old invoice objects captured before the optimistic edit
 */
export function restoreRows(previous) {
  let delta = 0;
  previous.forEach((invoice) => {
    const index = invoiceState.invoices.findIndex(
      (row) => row.id === invoice.id,
    );
    if (index === -1) return;
    const current = invoiceState.invoices[index];
    if (!invoice.category && current.category) delta += 1;
    if (invoice.category && !current.category) delta -= 1;
    invoiceState.invoices[index] = invoice;
  });
  adjustUncategorizedCount(delta);
  renderInvoices();
}

export function renderInvoices() {
  const { invoiceList } = els();
  // Selection is intentionally not pruned to the current page: it spans the
  // whole filtered set (see "select all"), so ids on other pages must survive
  // a re-render or page change.

  // Capture the roving tab stop before innerHTML is rebuilt so keyboard
  // navigation survives a full re-render (pagination, filters, undo reconcile).
  // Focus is only restored when the row itself held it, so a re-render that no
  // row was focused for never steals focus from the filter input etc.
  const activeRow = invoiceList.querySelector('.invoice-item[tabindex="0"]');
  const activeId = activeRow ? activeRow.dataset.id : null;
  const hadRowFocus =
    activeRow !== null && activeRow === document.activeElement;

  if (invoiceState.invoices.length === 0) {
    invoiceList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📋</div>
                <div class="empty-title">No invoices found</div>
                <div class="empty-text">Adjust your filter criteria or add new invoices.</div>
            </div>
        `;
  } else {
    invoiceList.innerHTML = invoiceState.invoices
      .map(
        (invoice, index) => `
            <div class="invoice-item ${
              selectedInvoices.has(invoice.id) ? "selected" : ""
            }" data-id="${invoice.id}" tabindex="${index === 0 ? 0 : -1}">
                <div class="invoice-header">
                    <label class="invoice-checkbox">
                        <input type="checkbox" ${
                          selectedInvoices.has(invoice.id) ? "checked" : ""
                        }>
                        <span class="checkbox-mark"></span>
                    </label>
                    <div class="invoice-main">
                        <span class="invoice-date">
                            <span class="invoice-date-full">${formatDate(
                              invoice.date,
                            )}</span>
                            <span class="invoice-date-short">${formatDateShort(
                              invoice.date,
                            )}</span>
                        </span>
                        <span class="invoice-store">${escapeHtml(
                          invoice.store,
                        )}</span>
                        ${invoice.category ? `<span class="invoice-type">${escapeHtml(invoice.category)}</span>` : ""}
                    </div>
                    <div class="invoice-meta">
                        <span class="invoice-total">${formatCurrency(
                          invoice.total,
                        )}</span>
                        <div class="invoice-expand">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"/>
                            </svg>
                        </div>
                    </div>
                </div>
                <div class="invoice-details">
                    <div class="items-table"></div>
                    <div class="invoice-actions">
                        <button class="btn btn-secondary btn-sm" data-action="edit">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            Edit
                        </button>
                        <button class="btn btn-danger btn-sm" data-action="delete">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="m19 6-.867 12.142A2 2 0 0 1 16.138 20H7.862a2 2 0 0 1-1.995-1.858L5 6"/>
                                <path d="M10 11v6"/>
                                <path d="M14 11v6"/>
                                <path d="m8 6 .544-1.632A2 2 0 0 1 10.442 3h3.116a2 2 0 0 1 1.898 1.368L16 6"/>
                            </svg>
                            Delete
                        </button>
                    </div>
                </div>
            </div>
        `,
      )
      .join("");

    // Colors are applied via the CSSOM (not a style attribute) so a strict
    // style-src CSP does not block them. textContent is the raw category name.
    invoiceList.querySelectorAll(".invoice-type").forEach((badge) => {
      applyCategoryBadge(badge, badge.textContent);
    });

    // Re-apply the roving tab stop to the previously active row if it survived
    // the render; otherwise the template default (first row) stands.
    const restored = activeId
      ? invoiceList.querySelector(`.invoice-item[data-id="${activeId}"]`)
      : null;
    if (restored) {
      const first = invoiceList.querySelector('.invoice-item[tabindex="0"]');
      if (first && first !== restored) first.tabIndex = -1;
      restored.tabIndex = 0;
      if (hadRowFocus) restored.focus();
    }
  }

  // Summary reflects the whole filtered set (server totals), not just this page
  document.querySelector('[data-el="results-count"]').textContent = `${
    invoiceState.totalCount
  } invoice${invoiceState.totalCount !== 1 ? "s" : ""}`;
  document.querySelector('[data-el="results-total"]').textContent =
    formatCurrency(invoiceState.totalSum);

  renderPagination();
  updateBulkActionToolbar();
  // Every optimistic mutation (edit/delete/bulk/categorize/undo) re-renders
  // through here, so refreshing the AI trigger badge at this single choke point
  // keeps its page-scoped count live without a call at each mutation site.
  updateAiTriggerBadge();
}

/**
 * Render the Prev/Next pagination control plus the page-size selector. The
 * container is a sibling of the invoice list (which is fully replaced on each
 * render), so it persists.
 */
function renderPagination() {
  const container = document.querySelector('[data-el="pagination"]');
  if (!container) return;

  if (invoiceState.totalCount === 0) {
    container.innerHTML = "";
    return;
  }

  const totalPages = Math.max(
    1,
    Math.ceil(invoiceState.totalCount / invoiceState.effectivePageSize),
  );
  container.innerHTML = `
    <button class="btn btn-secondary btn-sm" data-action="page-prev" ${
      invoiceState.page <= 1 ? "disabled" : ""
    }>Previous</button>
    <span class="pagination-info">
      <span class="pagination-info-long">Page ${invoiceState.page} of ${totalPages}</span>
      <span class="pagination-info-short">${invoiceState.page} / ${totalPages}</span>
    </span>
    <button class="btn btn-secondary btn-sm" data-action="page-next" ${
      invoiceState.page >= totalPages ? "disabled" : ""
    }>Next</button>
    ${renderPageSizeControl()}
  `;
}

export async function toggleInvoice(element) {
  const item = element.closest(".invoice-item");
  const expanded = item.classList.toggle("expanded");

  // Load line items on the first expand only; the compact list omits them.
  // The itemsLoading guard prevents a duplicate fetch when a row is collapsed
  // and re-expanded while its first request is still in flight.
  if (
    expanded &&
    item.dataset.itemsLoaded === undefined &&
    item.dataset.itemsLoading === undefined
  ) {
    await loadInvoiceItems(item);
  }
}

/**
 * Fetch and inject an invoice's line items into its expanded detail view,
 * caching via the `data-items-loaded` marker so re-expanding never refetches.
 * The `data-items-loading` marker (set before the await, cleared in `finally`)
 * blocks a concurrent fetch for the same row while one is in flight, without
 * blocking a retry after a failure (only success sets `data-items-loaded`).
 */
async function loadInvoiceItems(item) {
  const table = item.querySelector(".items-table");
  table.innerHTML = '<div class="item-row">Loading …</div>';
  item.dataset.itemsLoading = "true";
  try {
    const items = await fetchInvoiceItems(Number(item.dataset.id));
    table.innerHTML = itemRowsHtml(items);
    item.dataset.itemsLoaded = "true";
  } catch {
    table.innerHTML = '<div class="item-row">Failed to load items</div>';
  } finally {
    delete item.dataset.itemsLoading;
  }
}

/**
 * Wire the invoice list via event delegation so runtime-rendered rows need no
 * per-row listeners. One click and one change listener on the stable container
 * dispatch by the clicked element's `data-action` / its `.invoice-item[data-id]`.
 */
export function setupInvoiceListListeners() {
  const { invoiceList } = els();

  invoiceList.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const id = Number(actionButton.closest(".invoice-item").dataset.id);
      if (actionButton.dataset.action === "edit") editInvoice(id);
      else if (actionButton.dataset.action === "delete") deleteInvoice(id);
      return;
    }

    // Clicking the checkbox must not toggle the row (replaces stopPropagation)
    if (event.target.closest(".invoice-checkbox")) return;

    const header = event.target.closest(".invoice-header");
    if (header) toggleInvoice(header);
  });

  invoiceList.addEventListener("change", (event) => {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    const id = Number(checkbox.closest(".invoice-item").dataset.id);
    toggleInvoiceSelection(id, checkbox.checked);
  });

  invoiceList.addEventListener("keydown", handleListKeydown);
}

/**
 * Move the roving tab stop to `row` and focus it. Rows carry `tabindex="-1"`
 * except the current one (`0`), so the list is a single Tab stop that Arrow
 * keys navigate within.
 */
function focusRow(row) {
  if (!row || !row.classList.contains("invoice-item")) return;
  const list = row.parentElement;
  const current = list.querySelector('.invoice-item[tabindex="0"]');
  if (current) current.tabIndex = -1;
  row.tabIndex = 0;
  row.focus();
}

/**
 * Arrow/Home/End move focus between invoice rows; Enter expands the focused row.
 * Enter is ignored when focus sits on a control inside the row (edit/delete),
 * which handle their own activation.
 */
function handleListKeydown(event) {
  const row = event.target.closest(".invoice-item");
  if (!row) return;

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      focusRow(row.nextElementSibling);
      break;
    case "ArrowUp":
      event.preventDefault();
      focusRow(row.previousElementSibling);
      break;
    case "Home":
      event.preventDefault();
      focusRow(row.parentElement.firstElementChild);
      break;
    case "End":
      event.preventDefault();
      focusRow(row.parentElement.lastElementChild);
      break;
    case "Enter":
      if (event.target !== row) return;
      event.preventDefault();
      toggleInvoice(row.querySelector(".invoice-header"));
      break;
  }
}

export function updateBulkActionToolbar() {
  const toolbar = document.querySelector('[data-el="bulk-action-toolbar"]');
  const count = selectedInvoices.size;
  const allSelected =
    invoiceState.totalCount > 0 && count >= invoiceState.totalCount;

  toolbar
    .querySelector('[data-action="select-all"]')
    .setAttribute("aria-pressed", String(allSelected));

  if (count > 0) {
    toolbar.classList.add("visible");
    document.querySelector('[data-el="selected-count"]').textContent = count;
  } else {
    toolbar.classList.remove("visible");
  }

  // Update "select all" checkbox state against the full filtered set (all
  // pages), not just the visible page.
  const selectAllCheckbox = document.querySelector(
    '[data-el="select-all-checkbox"] input',
  );
  if (selectAllCheckbox && invoiceState.totalCount > 0) {
    selectAllCheckbox.checked = count >= invoiceState.totalCount;
    selectAllCheckbox.indeterminate =
      count > 0 && count < invoiceState.totalCount;
  } else if (selectAllCheckbox) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = false;
  }
}
