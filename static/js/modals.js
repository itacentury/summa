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
  readAmountInput,
  isAmbiguousAmountInput,
  ambiguousAmountReadings,
  formatAmountForInput,
  withEuro,
} from "./dom.js";
import { showErrorToast } from "./toast.js";
import { saveInvoice } from "./invoices.js";
import { fetchInvoiceItems } from "./api.js";
import { importJson, setImportCorrectionMode } from "./import.js";
import { getCombobox } from "./combobox.js";

// Rows come and go at runtime, so each price hint needs its own id for the
// input's aria-describedby.
let nextPriceHintId = 0;

/**
 * Build the inner markup for one add/edit item row (name, price, remove button).
 * Pre-fills the inputs when an existing item is passed.
 */
export function itemRowInnerHtml(item = null) {
  nextPriceHintId += 1;
  const hintId = `item-price-error-${nextPriceHintId}`;
  const nameValue = item ? ` value="${escapeHtml(item.item_name)}"` : "";
  let priceValue = item ? ` value="${item.item_price}"` : "";
  if (typeof item?.item_price === "number") {
    const priceText = formatAmountForInput(item.item_price);
    priceValue = ` value="${priceText}" data-amount="${item.item_price}"`;
  }
  // Known limitation: iOS's decimal pad has no minus key, so a negative price
  // (discount, deposit return) can't be typed there; paste it or enter it on
  // desktop. Accepted so phones open a keypad for the everyday positive price.
  return `
    <div class="form-group">
      <label class="form-label">Item Name</label>
      <input type="text" class="form-input item-name" placeholder="Product name"${nameValue}>
    </div>
    <div class="form-group">
      <label class="form-label">Price</label>
      <input type="text" inputmode="decimal" class="form-input item-price" placeholder="0.00" aria-describedby="${hintId}"${priceValue}>
    </div>
    <button type="button" class="btn btn-danger btn-sm" data-action="remove-item">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
    <p class="field-error item-price-error is-hidden" id="${hintId}" role="alert"></p>
  `;
}

/**
 * Why save would refuse this price field, or `null` when it would accept it.
 * A blank field is not invalid here; save reports a missing price itself.
 */
function invalidPriceHint(input) {
  if (isAmbiguousAmountInput(input)) {
    const { thousands, decimal } = ambiguousAmountReadings(input.value);
    return `Ambiguous: write ${thousands} for thousands or ${decimal} for three decimals.`;
  }
  if (Number.isNaN(readAmountInput(input))) {
    return "Invalid price: use digits with , or . as the decimal separator.";
  }
  return null;
}

/**
 * Show or clear the invalid-price flag and its text hint on one price field
 * (ambiguous or unparseable), and report whether the field is flagged.
 * Pass `announce: false` to update the hint without a screen-reader alert.
 */
export function flagInvalidPrice(input, { announce = true } = {}) {
  const message = invalidPriceHint(input);
  const hint = input
    .closest(".item-input-row")
    .querySelector(".item-price-error");
  const flagged = message !== null;
  // An unchanged flag must not touch role or text: after a mouse-clicked save
  // the deferred focusout flag would turn the hint back into an alert and
  // re-fire it after the toast already spoke.
  if (
    input.getAttribute("aria-invalid") === String(flagged) &&
    hint.textContent === (message ?? "")
  ) {
    return flagged;
  }
  // A refused save already speaks through its toast and the focused field's
  // description, so its alert would be a third copy. The role must be set
  // before the hint is revealed: an alert fires on the content change.
  if (announce) {
    hint.setAttribute("role", "alert");
  } else {
    hint.removeAttribute("role");
  }
  input.setAttribute("aria-invalid", String(flagged));
  hint.classList.toggle("is-hidden", !flagged);
  hint.textContent = message ?? "";
  return flagged;
}

/**
 * Clear a flagged price field as soon as its value is valid again. Never
 * raises the flag: `1.234,56` passes through `1.234` and `12,5` through `12,`
 * while typing, so only leaving the field (or a refused save) may do that.
 */
export function clearPriceFlagIfResolved(input) {
  if (input.getAttribute("aria-invalid") !== "true") return;
  if (invalidPriceHint(input) !== null) return;
  flagInvalidPrice(input);
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
  const prices = document.querySelectorAll(".item-input-row .item-price");
  let total = 0;
  prices.forEach((input) => {
    // Save refuses an ambiguous or unparseable price, so the total must not
    // count it either; flagInvalidPrice explains why once the user leaves
    // the field.
    if (isAmbiguousAmountInput(input)) return;
    const price = readAmountInput(input);
    if (Number.isNaN(price)) return;
    total += price ?? 0;
  });
  document.querySelector('[data-el="calculated-total"]').textContent = withEuro(
    formatCurrency(total),
  );
}

/** Run `callback` once the current press ends, after its click has fired. */
function afterPress(callback) {
  const finish = () => {
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    setTimeout(callback);
  };
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

/**
 * Keep the live total and the invalid-price flags of the item rows current.
 * Item rows are rebuilt at runtime, so this delegates from the stable container.
 */
export function setupItemPriceListeners(addModal) {
  const itemsContainer = addModal.querySelector('[data-el="items-container"]');
  let pointerIsDown = false;
  addModal.addEventListener("pointerdown", () => {
    pointerIsDown = true;
  });
  const releasePointer = () => {
    pointerIsDown = false;
  };
  document.addEventListener("pointerup", releasePointer);
  document.addEventListener("pointercancel", releasePointer);

  itemsContainer.addEventListener("input", (event) => {
    calculateTotal();
    if (event.target.matches(".item-price")) {
      clearPriceFlagIfResolved(event.target);
    }
  });
  // focusout, not blur: blur doesn't bubble to the delegating container.
  itemsContainer.addEventListener("focusout", (event) => {
    if (!event.target.matches(".item-price")) return;
    const input = event.target;
    if (!pointerIsDown) {
      flagInvalidPrice(input);
      return;
    }
    // Focus leaves on mousedown. Showing the hint now would push the rows
    // below it down before mouseup, so the release would miss the pressed
    // button and its click would never fire.
    afterPress(() => {
      if (input.isConnected) flagInvalidPrice(input);
    });
  });
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

  setupItemPriceListeners(addModal);
  const itemsContainer = addModal.querySelector('[data-el="items-container"]');
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
