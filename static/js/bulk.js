/**
 * Multi-select, bulk-edit and bulk-delete behavior over the invoice list.
 */

import { state, selectedInvoices } from "./state.js";
import {
  fetchFilteredIds,
  loadCategories,
  loadStores,
  reloadCurrentPage,
} from "./api.js";
import {
  renderInvoices,
  updateBulkActionToolbar,
  captureRows,
  reinsertRows,
  restoreRows,
} from "./render.js";
import { lockScroll, unlockScroll } from "./modals.js";
import { getCombobox } from "./combobox.js";
import { showUndoToast, showErrorToast, hasPendingToast } from "./toast.js";
import { apiFetch } from "./http.js";

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
  if (state.totalCount > 0 && selectedInvoices.size >= state.totalCount) {
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
  const visibleSelected = state.invoices.filter((invoice) =>
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
  document.querySelector('[data-el="bulk-edit-modal"]').classList.add("active");
  lockScroll();
  storeInput.focus();
}

export function closeBulkEditModal() {
  document
    .querySelector('[data-el="bulk-edit-modal"]')
    .classList.remove("active");
  unlockScroll();
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
  const previous = state.invoices.filter((invoice) => idSet.has(invoice.id));
  state.invoices = state.invoices.map((invoice) => {
    if (!idSet.has(invoice.id)) return invoice;
    const updated = { ...invoice };
    if (newStore) updated.store = newStore;
    if (newCategory) updated.category = newCategory;
    return updated;
  });
  closeBulkEditModal();
  selectedInvoices.clear();
  renderInvoices();

  const count = ids.length;
  const revert = () => {
    ids.forEach((id) => selectedInvoices.add(id));
    restoreRows(previous);
  };

  const commit = async () => {
    try {
      const response = await apiFetch("/api/invoices/bulk-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // Survive page unload: a beforeunload-triggered commit must reach the
        // server even as the document tears down.
        keepalive: true,
      });
      const result = await response.json();
      if (!result.success) {
        showErrorToast("Failed to update");
        revert();
        return;
      }
      // A bulk edit can rename stores / add or remove categories, so the lookup
      // dropdowns always need refreshing — no superseding action reconciles
      // THIS edit's values. Only the invoice-list reconcile is skipped while a
      // newer deferred action is still pending (it reconciles on its own
      // commit), so this earlier commit's reload can't cut short the newer
      // action's undo window or flicker its rows back in.
      loadStores();
      loadCategories();
      if (!hasPendingToast()) reloadCurrentPage();
    } catch {
      showErrorToast("Failed to update");
      revert();
    }
  };

  showUndoToast(`${count} invoice${count !== 1 ? "s" : ""} updated`, {
    onUndo: revert,
    onCommit: commit,
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
  state.invoices = state.invoices.filter((invoice) => !idSet.has(invoice.id));
  state.totalCount -= ids.length;
  state.totalSum -= removed.reduce(
    (sum, { invoice }) => sum + Number(invoice.total),
    0,
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

  const commit = async () => {
    try {
      const response = await apiFetch("/api/invoices/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
        // Survive page unload: a beforeunload-triggered commit must reach the
        // server even as the document tears down.
        keepalive: true,
      });
      const result = await response.json();
      if (!result.success) {
        showErrorToast("Failed to delete");
        revert();
        return;
      }
      // Reload the list only; stale lookup options self-heal (see deleteInvoice).
      // Skip the reconcile if a newer deferred action is still pending — it
      // reconciles on its own commit. Prevents this earlier commit's reload from
      // cutting short the newer action's undo window (and flickering its rows back in).
      if (!hasPendingToast()) reloadCurrentPage();
    } catch {
      showErrorToast("Failed to delete");
      revert();
    }
  };

  showUndoToast(`${count} invoice${count !== 1 ? "s" : ""} deleted`, {
    onUndo: revert,
    onCommit: commit,
  });
}
