/**
 * Single-invoice create/update/delete actions.
 *
 * Delete and edit are deferred: the change is reflected in the list immediately
 * but only sent to the server when the undo window closes (see toast.js). Undo
 * reverts the local snapshot without ever touching the server.
 */

import { invoiceState, selectedInvoices } from "./state.js";
import { loadCategories, loadInvoices, loadStores } from "./api.js";
import { closeAddModal, validateInvoiceDate } from "./modals.js";
import { getCombobox } from "./combobox.js";
import { showNoticeToast, showErrorToast } from "./toast.js";
import { deferCommit } from "./deferred.js";
import {
  adjustUncategorizedCount,
  countUncategorized,
  reinsertRows,
  restoreRows,
  renderInvoices,
} from "./render.js";
import { apiFetch, sendJson } from "./http.js";
import { withBusyButton } from "./dom.js";

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

  const editingId = invoiceState.editingInvoiceId;
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
  await withBusyButton(saveButton, async () => {
    try {
      const response = await sendJson("/api/invoices", "POST", payload);

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
    }
  });
}

/**
 * Apply an edit optimistically and defer the PUT behind an undo toast. The
 * visible row is replaced (not mutated) so the snapshot keeps the old values.
 */
function deferInvoiceUpdate(id, payload) {
  const index = invoiceState.invoices.findIndex((invoice) => invoice.id === id);
  const previous = index !== -1 ? invoiceState.invoices[index] : null;
  if (index !== -1) {
    invoiceState.invoices[index] = {
      ...invoiceState.invoices[index],
      date: payload.date,
      store: payload.store,
      category: payload.category,
      total: payload.total,
    };
  }
  // An edit can clear a category as well as set one, so this is the single path
  // where the uncategorized count moves up.
  if (previous && Boolean(previous.category) !== Boolean(payload.category)) {
    adjustUncategorizedCount(payload.category ? -1 : 1);
  }
  renderInvoices();
  closeAddModal();

  const restore = () => {
    if (previous) restoreRows([previous]);
  };

  deferCommit("Invoice updated", {
    send: (init) => sendJson(`/api/invoices/${id}`, "PUT", payload, init),
    onUndo: restore,
    errorText: "Failed to update",
    onSuccess: () => refreshLookupsFor(payload.store, payload.category),
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
  const index = invoiceState.invoices.findIndex((invoice) => invoice.id === id);
  if (index === -1) return;
  const removed = invoiceState.invoices[index];
  const wasSelected = selectedInvoices.has(id);

  invoiceState.invoices = invoiceState.invoices.filter(
    (invoice) => invoice.id !== id,
  );
  selectedInvoices.delete(id);
  invoiceState.totalCount -= 1;
  invoiceState.totalSum -= Number(removed.total);
  adjustUncategorizedCount(-countUncategorized([removed]));
  renderInvoices();

  const restore = () => reinsertRows([{ invoice: removed, index }]);
  const undo = () => {
    if (wasSelected) selectedInvoices.add(id);
    restore();
  };

  // A store/category option lingering after its last invoice is deleted is
  // cosmetic and self-heals on the next lookup load, so only the list reloads.
  deferCommit("Invoice deleted", {
    send: (init) =>
      apiFetch(`/api/invoices/${id}`, { method: "DELETE", ...init }),
    onUndo: undo,
    errorText: "Failed to delete",
  });
}
