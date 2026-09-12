/**
 * Single-invoice create/update/delete actions.
 *
 * Delete and edit are deferred: the change is reflected in the list immediately
 * but only sent to the server when the undo window closes (see toast.js). Undo
 * reverts the local snapshot without ever touching the server.
 */

import { state, selectedInvoices } from "./state.js";
import {
  loadCategories,
  loadInvoices,
  loadStores,
  reloadCurrentPage,
} from "./api.js";
import { closeAddModal, validateInvoiceDate } from "./modals.js";
import { getCombobox } from "./combobox.js";
import {
  showUndoToast,
  showNoticeToast,
  showErrorToast,
  hasPendingToast,
} from "./toast.js";
import { reinsertRows, restoreRows, renderInvoices } from "./render.js";
import { apiFetch } from "./http.js";

export async function saveInvoice() {
  const date = document.querySelector('[data-el="invoice-date"]').value;
  const store = document.querySelector('[data-el="invoice-store"]').value;
  const type =
    document.querySelector('[data-el="invoice-type"]').value.trim() || null;

  if (!date || !store) {
    showErrorToast("Please fill in date and store");
    return;
  }

  // A legacy invoice can carry a future date the picker's `max` now forbids;
  // the inline hint explains why, so block the save rather than round-trip a 400.
  if (validateInvoiceDate()) {
    document.querySelector('[data-el="invoice-date"]').focus();
    return;
  }

  const items = [];
  const rows = document.querySelectorAll(".item-input-row");
  rows.forEach((row) => {
    const name = row.querySelector(".item-name").value;
    const price = row.querySelector(".item-price").value;
    if (name && price) {
      items.push({ item_name: name, item_price: price });
    }
  });

  if (items.length === 0) {
    showErrorToast("Please add at least one item");
    return;
  }

  const total = items.reduce(
    (sum, item) => sum + parseFloat(item.item_price),
    0,
  );

  const editingId = state.editingInvoiceId;
  const payload = { date, store, category: type, total, items };

  if (editingId) {
    deferInvoiceUpdate(editingId, payload);
  } else {
    await createInvoice(payload);
  }
}

/** Create a new invoice immediately (create has no useful deferred undo). */
async function createInvoice(payload) {
  const saveButton = document.querySelector(
    '[data-el="add-invoice-modal"] [data-action="save"]',
  );
  const originalContent = saveButton.innerHTML;
  saveButton.innerHTML = '<div class="spinner"></div>';
  saveButton.disabled = true;

  try {
    const response = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      showErrorToast("Failed to save");
      return;
    }

    showNoticeToast("Invoice saved");
    closeAddModal();
    refreshLookupsFor(payload.store, payload.category);
    // A new invoice jumps to page 1 so it is visible at the top of the
    // date-descending sort.
    loadInvoices();
  } catch {
    showErrorToast("Failed to save");
  } finally {
    saveButton.innerHTML = originalContent;
    saveButton.disabled = false;
  }
}

/**
 * Apply an edit optimistically and defer the PUT behind an undo toast. The
 * visible row is replaced (not mutated) so the snapshot keeps the old values.
 */
function deferInvoiceUpdate(id, payload) {
  const index = state.invoices.findIndex((invoice) => invoice.id === id);
  const previous = index !== -1 ? state.invoices[index] : null;
  if (index !== -1) {
    state.invoices[index] = {
      ...state.invoices[index],
      date: payload.date,
      store: payload.store,
      category: payload.category,
      total: payload.total,
    };
  }
  renderInvoices();
  closeAddModal();

  const restore = () => {
    if (previous) restoreRows([previous]);
  };

  const commit = async () => {
    try {
      const response = await apiFetch(`/api/invoices/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // Survive page unload: a beforeunload-triggered commit must reach the
        // server even as the document tears down.
        keepalive: true,
      });
      if (!response.ok) {
        showErrorToast("Failed to update");
        restore();
        return;
      }
      refreshLookupsFor(payload.store, payload.category);
      // Skip the reconcile if a newer deferred action is still pending — it
      // reconciles on its own commit. Prevents this earlier commit's reload from
      // cutting short the newer action's undo window (and flickering its row back in).
      if (!hasPendingToast()) reloadCurrentPage();
    } catch {
      showErrorToast("Failed to update");
      restore();
    }
  };

  showUndoToast("Invoice updated", {
    onUndo: restore,
    onCommit: commit,
  });
}

/**
 * Reload the store/category lookups only when a save introduced a value the
 * filter comboboxes don't have yet.
 */
function refreshLookupsFor(store, category) {
  const storeCombobox = getCombobox("store-filter");
  const typeCombobox = getCombobox("type-filter");
  if (store && storeCombobox && !storeCombobox.hasOption(store)) {
    loadStores();
  }
  if (category && typeCombobox && !typeCombobox.hasOption(category)) {
    loadCategories();
  }
}

/**
 * Remove an invoice optimistically and defer the DELETE behind an undo toast.
 * The row already exists server-side (soft delete happens only on commit), so
 * undo just restores the local snapshot.
 */
export function deleteInvoice(id) {
  const index = state.invoices.findIndex((invoice) => invoice.id === id);
  if (index === -1) return;
  const removed = state.invoices[index];
  const wasSelected = selectedInvoices.has(id);

  state.invoices = state.invoices.filter((invoice) => invoice.id !== id);
  selectedInvoices.delete(id);
  state.totalCount -= 1;
  state.totalSum -= Number(removed.total);
  renderInvoices();

  const restore = () => reinsertRows([{ invoice: removed, index }]);

  const commit = async () => {
    try {
      // keepalive: finalize the delete even if this commit fires during unload.
      const response = await apiFetch(`/api/invoices/${id}`, {
        method: "DELETE",
        keepalive: true,
      });
      if (!response.ok) {
        showErrorToast("Failed to delete");
        restore();
        return;
      }
      // A store/category option lingering after its last invoice is deleted is
      // cosmetic and self-heals on the next lookup load, so reload the list only.
      // Skip the reconcile if a newer deferred action is still pending — it
      // reconciles on its own commit. Prevents this earlier commit's reload from
      // cutting short the newer action's undo window (and flickering its row back in).
      if (!hasPendingToast()) reloadCurrentPage();
    } catch {
      showErrorToast("Failed to delete");
      restore();
    }
  };

  const undo = () => {
    if (wasSelected) selectedInvoices.add(id);
    restore();
  };

  showUndoToast("Invoice deleted", { onUndo: undo, onCommit: commit });
}
