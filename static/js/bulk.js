/**
 * Multi-select, bulk-edit and bulk-delete behavior over the invoice list.
 */

import { invoiceState, selectedInvoices } from "./state.js";
import { fetchFilteredIds, loadLookups } from "./api.js";
import {
  renderInvoices,
  updateBulkActionToolbar,
  captureRows,
  adjustUncategorizedCount,
  countUncategorized,
  reinsertRows,
  restoreRows,
} from "./render.js";
import { hideOverlay, showOverlay } from "./modals.js";
import { getCombobox } from "./combobox.js";
import { showErrorToast } from "./toast.js";
import { deferCommit } from "./deferred.js";
import { sendJson } from "./http.js";

export function toggleInvoiceSelection(invoiceId, isSelected) {
  if (isSelected) {
    selectedInvoices.add(invoiceId);
  } else {
    selectedInvoices.delete(invoiceId);
  }

  // Update visual state of the invoice item
  const invoiceItem = document.querySelector(
    `.invoice-item[data-id="${invoiceId}"]`,
  );
  if (invoiceItem) {
    invoiceItem.classList.toggle("selected", isSelected);
  }

  updateBulkActionToolbar();
}

export async function toggleSelectAll(isSelected) {
  if (isSelected) {
    await selectAllInvoices();
  } else {
    selectedInvoices.clear();
    renderInvoices();
  }
}

/**
 * Select every invoice matching the active filters, across all pages, by
 * fetching the full filtered id set from the server.
 */
export async function selectAllInvoices() {
  try {
    const ids = await fetchFilteredIds();
    ids.forEach((id) => selectedInvoices.add(id));
  } catch {
    showErrorToast("Failed to select all invoices");
    renderInvoices();
    return;
  }
  renderInvoices();
}

export function deselectAllInvoices() {
  selectedInvoices.clear();
  renderInvoices();
}

/**
 * Toolbar "Select All" toggle: selects the full filtered set, or clears the
 * selection when everything is already selected.
 */
function toggleSelectAllButton() {
  if (
    invoiceState.totalCount > 0 &&
    selectedInvoices.size >= invoiceState.totalCount
  ) {
    deselectAllInvoices();
  } else {
    selectAllInvoices();
  }
}

export function openBulkEditModal() {
  if (selectedInvoices.size === 0) return;

  // Derive the common store/category from the selected invoices to pre-fill the
  // form. Only the current page is loaded client-side, so we can only trust a
  // "common value" when every selected invoice is on this page; otherwise a
  // value shared here might not hold for off-page selections.
  const selectedStores = new Set();
  const selectedCategories = new Set();
  const visibleSelected = invoiceState.invoices.filter((invoice) =>
    selectedInvoices.has(invoice.id),
  );
  visibleSelected.forEach((invoice) => {
    selectedStores.add(invoice.store);
    if (invoice.category) {
      selectedCategories.add(invoice.category);
    }
  });
  const allVisible = visibleSelected.length === selectedInvoices.size;

  // Pre-fill with the common store name if all selected are visible and share it
  const storeInput = document.querySelector('[data-el="bulk-edit-store"]');
  if (allVisible && selectedStores.size === 1) {
    storeInput.value = [...selectedStores][0];
  } else if (allVisible) {
    storeInput.value = "";
    storeInput.placeholder = `${selectedStores.size} different stores`;
  } else {
    storeInput.value = "";
    storeInput.placeholder = "Leave empty to keep unchanged";
  }

  // Pre-fill with the common category only if every selected invoice is visible
  // and shares it; otherwise leave it empty (keep unchanged).
  const categoryCombobox = getCombobox("bulk-edit-category");
  if (allVisible && selectedCategories.size === 1) {
    categoryCombobox.setValue([...selectedCategories][0]);
    categoryCombobox.setPlaceholder("");
  } else if (allVisible && selectedCategories.size > 1) {
    categoryCombobox.setValue("");
    categoryCombobox.setPlaceholder(
      `${selectedCategories.size} different categories`,
    );
  } else {
    categoryCombobox.setValue("");
    categoryCombobox.setPlaceholder("Leave empty to keep unchanged");
  }

  document.querySelector('[data-el="bulk-edit-count"]').textContent =
    selectedInvoices.size;
  showOverlay(document.querySelector('[data-el="bulk-edit-modal"]'));
  storeInput.focus();
}

export function closeBulkEditModal() {
  hideOverlay(document.querySelector('[data-el="bulk-edit-modal"]'));
  document.querySelector('[data-el="bulk-edit-store"]').value = "";
  const categoryCombobox = getCombobox("bulk-edit-category");
  categoryCombobox.setValue("");
  categoryCombobox.setPlaceholder("");
}

export function saveBulkEdit() {
  const newStore = document
    .querySelector('[data-el="bulk-edit-store"]')
    .value.trim();
  const newCategory = document
    .querySelector('[data-el="bulk-edit-category"]')
    .value.trim();

  if (!newStore && !newCategory) {
    showErrorToast("Please fill in at least one field");
    return;
  }

  const ids = [...selectedInvoices];
  const idSet = new Set(ids);
  const payload = { ids };

  if (newStore) {
    payload.store = newStore;
  }
  if (newCategory) {
    // Only send category if the field has a value
    payload.category = newCategory;
  }

  // Apply optimistically to the visible selected rows (replace, don't mutate, so
  // the snapshot keeps the old values). Off-page selected rows are updated on
  // the server at commit time; the deferred PUT carries every selected id.
  const previous = invoiceState.invoices.filter((invoice) =>
    idSet.has(invoice.id),
  );
  invoiceState.invoices = invoiceState.invoices.map((invoice) => {
    if (!idSet.has(invoice.id)) return invoice;
    const updated = { ...invoice };
    if (newStore) updated.store = newStore;
    if (newCategory) updated.category = newCategory;
    return updated;
  });
  // Only the visible rows can be counted; off-page selected ones reconcile on
  // commit, the same limitation totalSum carries in bulkDeleteInvoices.
  if (newCategory) adjustUncategorizedCount(-countUncategorized(previous));
  closeBulkEditModal();
  selectedInvoices.clear();
  renderInvoices();

  const count = ids.length;
  const revert = () => {
    ids.forEach((id) => selectedInvoices.add(id));
    restoreRows(previous);
  };

  deferCommit(`${count} invoice${count !== 1 ? "s" : ""} updated`, {
    send: (init) => sendJson("/api/invoices/bulk-update", "PUT", payload, init),
    onUndo: revert,
    errorText: "Failed to update",
    // A bulk edit can rename stores and add or drop categories, and no later
    // action reconciles this edit's values, so the lookups always reload.
    onSuccess: loadLookups,
  });
}

/**
 * Wire the bulk-action toolbar, the bulk-edit modal and the select-all checkbox.
 */
export function setupBulkListeners() {
  const toolbar = document.querySelector('[data-el="bulk-action-toolbar"]');
  toolbar
    .querySelector('[data-action="select-all"]')
    .addEventListener("click", toggleSelectAllButton);
  toolbar
    .querySelector('[data-action="deselect-all"]')
    .addEventListener("click", deselectAllInvoices);
  toolbar
    .querySelector('[data-action="bulk-edit"]')
    .addEventListener("click", openBulkEditModal);
  toolbar
    .querySelector('[data-action="bulk-delete"]')
    .addEventListener("click", bulkDeleteInvoices);

  const bulkEditModal = document.querySelector('[data-el="bulk-edit-modal"]');
  bulkEditModal
    .querySelector(".modal-close")
    .addEventListener("click", closeBulkEditModal);
  bulkEditModal
    .querySelector('[data-action="cancel"]')
    .addEventListener("click", closeBulkEditModal);
  bulkEditModal
    .querySelector('[data-action="save"]')
    .addEventListener("click", saveBulkEdit);

  const selectAllCheckbox = document.querySelector(
    '[data-el="select-all-checkbox"] input',
  );
  selectAllCheckbox.addEventListener("change", () => {
    toggleSelectAll(selectAllCheckbox.checked);
  });
}

export function bulkDeleteInvoices() {
  const count = selectedInvoices.size;
  if (count === 0) return;

  const ids = [...selectedInvoices];
  const idSet = new Set(ids);

  // Optimistically drop the selected rows. totalCount reflects the full
  // selection (may span pages); totalSum can only subtract the visible rows'
  // totals — reloadCurrentPage on commit reconciles both with the server.
  const removed = captureRows(idSet);
  invoiceState.invoices = invoiceState.invoices.filter(
    (invoice) => !idSet.has(invoice.id),
  );
  invoiceState.totalCount -= ids.length;
  invoiceState.totalSum -= removed.reduce(
    (sum, { invoice }) => sum + Number(invoice.total),
    0,
  );
  adjustUncategorizedCount(
    -countUncategorized(removed.map(({ invoice }) => invoice)),
  );
  selectedInvoices.clear();
  renderInvoices();

  // Selected rows on other pages aren't in `removed`; restore their count
  // separately (their sum was never subtracted above).
  const extraCount = ids.length - removed.length;
  const revert = () => {
    ids.forEach((id) => selectedInvoices.add(id));
    reinsertRows(removed, extraCount);
  };

  // Stale lookup options self-heal, as after a single delete.
  deferCommit(`${count} invoice${count !== 1 ? "s" : ""} deleted`, {
    send: (init) =>
      sendJson("/api/invoices/bulk-delete", "POST", { ids }, init),
    onUndo: revert,
    errorText: "Failed to delete",
  });
}
