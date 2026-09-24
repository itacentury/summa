/**
 * Modal lifecycle (scroll lock, open/close) for the add/edit and import dialogs,
 * plus the dynamic item rows of the add/edit form.
 */

import { state } from "./state.js";
import {
  escapeHtml,
  formatCurrency,
  todayIso,
  isFutureIsoDate,
  capAtToday,
  withEuro,
} from "./dom.js";
import { showErrorToast } from "./toast.js";
import { saveInvoice } from "./invoices.js";
import { fetchInvoiceItems } from "./api.js";
import { importJson, setImportCorrectionMode } from "./import.js";
import { getCombobox } from "./combobox.js";

/**
 * Build the inner markup for one add/edit item row (name, price, remove button).
 * Pre-fills the inputs when an existing item is passed.
 */
export function itemRowInnerHtml(item = null) {
  const nameValue = item ? ` value="${escapeHtml(item.item_name)}"` : "";
  const priceValue = item ? ` value="${item.item_price}"` : "";
  return `
    <div class="form-group">
      <label class="form-label">Item Name</label>
      <input type="text" class="form-input item-name" placeholder="Product name"${nameValue}>
    </div>
    <div class="form-group">
      <label class="form-label">Price</label>
      <input type="number" step="0.01" class="form-input item-price" placeholder="0.00"${priceValue}>
    </div>
    <button type="button" class="btn btn-danger btn-sm" data-action="remove-item">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;
}

/**
 * Lock body scroll to prevent background scrolling while a modal is open.
 */
export function lockScroll() {
  document.body.style.overflow = "hidden";
}

/**
 * Restore body scroll when no modals, drawer or mobile filter sheet are open.
 */
export function unlockScroll() {
  const anyOpen =
    document.querySelector(".modal-overlay.active") ||
    document.body.classList.contains("drawer-open") ||
    document.body.classList.contains("filter-sheet-open");
  if (!anyOpen) {
    document.body.style.overflow = "";
  }
}

/** Open a `.modal-overlay` and lock the page behind it. */
export function showOverlay(overlay) {
  overlay.classList.add("active");
  lockScroll();
}

/** Close a `.modal-overlay`; the page scrolls again once nothing else is open. */
export function hideOverlay(overlay) {
  overlay.classList.remove("active");
  unlockScroll();
}

export function openAddModal() {
  state.editingInvoiceId = null;
  document.querySelector(
    '[data-el="add-invoice-modal"] .modal-title',
  ).textContent = "New Invoice";
  showOverlay(document.querySelector('[data-el="add-invoice-modal"]'));
  resetAddForm();
  const dateInput = document.querySelector('[data-el="invoice-date"]');
  capAtToday(dateInput);
  dateInput.value = todayIso();
  validateInvoiceDate();
}

/**
 * Toggle the inline "future date" hint under the date field and report whether
 * the field currently holds a future date. Legacy rows created before the
 * future-date guard can carry one; this surfaces that invalid state instead of
 * letting a save fail silently with a generic toast.
 */
export function validateInvoiceDate() {
  const dateInput = document.querySelector('[data-el="invoice-date"]');
  const hint = document.querySelector('[data-el="invoice-date-error"]');
  const isFuture = isFutureIsoDate(dateInput.value);
  hint.classList.toggle("is-hidden", !isFuture);
  dateInput.setAttribute("aria-invalid", String(isFuture));
  return isFuture;
}

export function closeAddModal() {
  hideOverlay(document.querySelector('[data-el="add-invoice-modal"]'));
  state.editingInvoiceId = null;
  resetAddForm();
}

export async function editInvoice(id) {
  state.editingInvoiceId = id;
  const invoice = state.invoices.find((inv) => inv.id === id);

  if (!invoice) {
    showErrorToast("Invoice not found");
    return;
  }

  document.querySelector(
    '[data-el="add-invoice-modal"] .modal-title',
  ).textContent = "Edit Invoice";

  // Fill in the form
  const dateInput = document.querySelector('[data-el="invoice-date"]');
  capAtToday(dateInput);
  dateInput.value = invoice.date;
  validateInvoiceDate();
  document.querySelector('[data-el="invoice-store"]').value = invoice.store;
  getCombobox("invoice-type").setValue(invoice.category || "");

  // The compact list no longer carries items, so load them on demand.
  let items;
  try {
    items = await fetchInvoiceItems(id);
  } catch {
    // A newer editInvoice() superseded this one; that call owns the error surface.
    if (state.editingInvoiceId !== id) return;
    showErrorToast("Failed to load invoice");
    return;
  }

  // A newer editInvoice() superseded this one while items were loading; its
  // header and editingInvoiceId now own the modal, so don't inject stale items.
  if (state.editingInvoiceId !== id) return;

  const itemsContainer = document.querySelector('[data-el="items-container"]');
  itemsContainer.innerHTML = "";

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "item-input-row";
    row.innerHTML = itemRowInnerHtml(item);
    itemsContainer.appendChild(row);
  });

  calculateTotal();
  showOverlay(document.querySelector('[data-el="add-invoice-modal"]'));
}

function resetAddForm() {
  document.querySelector('[data-el="add-form"]').reset();
  getCombobox("invoice-type").setValue("");
  document.querySelector('[data-el="items-container"]').innerHTML =
    `<div class="item-input-row">${itemRowInnerHtml()}</div>`;
  calculateTotal();
}

export function openImportModal() {
  showOverlay(document.querySelector('[data-el="import-modal"]'));
}

export function closeImportModal() {
  hideOverlay(document.querySelector('[data-el="import-modal"]'));
  document.querySelector('[data-el="json-input"]').value = "";
  document.querySelector('[data-el="file-input"]').value = "";
  state.pendingFiles = [];
  document
    .querySelector('[data-el="selected-files"]')
    .classList.add("is-hidden");

  // Clear any staged import errors so reopening never shows stale cards.
  const importErrors = document.querySelector('[data-el="import-errors"]');
  importErrors.innerHTML = "";
  importErrors.classList.add("is-hidden");
  state.importErrors = [];

  // Restore the fresh-input controls hidden while in correction mode.
  setImportCorrectionMode(false);
}

export function addItemRow() {
  const container = document.querySelector('[data-el="items-container"]');
  const row = document.createElement("div");
  row.className = "item-input-row";
  row.innerHTML = itemRowInnerHtml();
  container.appendChild(row);
}

export function removeItemRow(button) {
  const rows = document.querySelectorAll(".item-input-row");
  if (rows.length > 1) {
    button.closest(".item-input-row").remove();
    calculateTotal();
  }
}

export function calculateTotal() {
  const prices = document.querySelectorAll(".item-price");
  let total = 0;
  prices.forEach((input) => {
    total += parseFloat(input.value) || 0;
  });
  document.querySelector('[data-el="calculated-total"]').textContent = withEuro(
    formatCurrency(total),
  );
}

/**
 * Wire the modal open/close buttons and the add/edit form, including delegation
 * on the items container for the dynamically added item rows.
 */
export function setupModalListeners() {
  // Every trigger opens the modal (drawer buttons and the mobile FAB)
  document
    .querySelectorAll('[data-action="open-add"]')
    .forEach((button) => button.addEventListener("click", openAddModal));
  document
    .querySelectorAll('[data-action="open-import"]')
    .forEach((button) => button.addEventListener("click", openImportModal));

  // Add/edit invoice modal
  const addModal = document.querySelector('[data-el="add-invoice-modal"]');
  addModal
    .querySelector(".modal-close")
    .addEventListener("click", closeAddModal);
  addModal
    .querySelector('[data-action="cancel"]')
    .addEventListener("click", closeAddModal);
  addModal
    .querySelector('[data-action="add-item"]')
    .addEventListener("click", addItemRow);
  addModal
    .querySelector('[data-action="save"]')
    .addEventListener("click", saveInvoice);
  // Two guards: the input's `max` narrows the picker (set on modal open, see
  // openAddModal / editInvoice, so it stays fresh across midnight in long-lived
  // PWA sessions), and validateInvoiceDate is the actual future-date check —
  // `max` alone can't be trusted, see capAtToday in dom.js.
  addModal
    .querySelector('[data-el="invoice-date"]')
    .addEventListener("input", validateInvoiceDate);

  // Item rows are rebuilt at runtime, so delegate from the stable container
  const itemsContainer = document.querySelector('[data-el="items-container"]');
  itemsContainer.addEventListener("input", calculateTotal);
  itemsContainer.addEventListener("click", (event) => {
    const removeButton = event.target.closest('[data-action="remove-item"]');
    if (removeButton) removeItemRow(removeButton);
  });

  // Clicking the dimmed backdrop closes any dialog via its own ✕ button, so
  // each modal's close/reset logic stays in one place. Track where the press
  // started: a drag that begins inside the dialog (e.g. selecting text in an
  // input) and is released over the backdrop fires click on the overlay and
  // must not close it.
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    let pressStartedOnOverlay = false;
    overlay.addEventListener("pointerdown", (event) => {
      pressStartedOnOverlay = event.target === overlay;
    });
    overlay.addEventListener("click", (event) => {
      if (pressStartedOnOverlay && event.target === overlay) {
        overlay.querySelector(".modal-close").click();
      }
    });
  });

  // Import modal
  const importModal = document.querySelector('[data-el="import-modal"]');
  importModal
    .querySelector(".modal-close")
    .addEventListener("click", closeImportModal);
  importModal
    .querySelector('[data-action="cancel"]')
    .addEventListener("click", closeImportModal);
  importModal
    .querySelector('[data-action="import"]')
    .addEventListener("click", importJson);
}
