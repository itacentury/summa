/**
 * The weekly snapshot form. A blank field travels as `null`, the API's "carry
 * the previous value forward" signal, never as zero. Focus trap, Esc and the
 * sheet gesture come from the `.modal-*` classes, so nothing is registered.
 */

import { apiFetch, errorMessage, sendJson } from "./http.js";
import { showErrorToast, showNoticeToast } from "./toast.js";
import { hideOverlay, showOverlay } from "./modals.js";
import { escapeHtml, todayIso, withBusyButton } from "./dom.js";
import {
  formatAmount,
  formatDateDots,
  formatEuro,
  parseAmountInput,
  toneClass,
} from "./portfolio-format.js";
import { loadPortfolio } from "./portfolio.js";
import { openPositionModal } from "./portfolio-position.js";

// The open form's prefilled positions: what the delta and total need beyond the DOM.
const positions = new Map();

// Lets re-entering any covered date, not just the newest, warn that it
// replaces; the server upserts silently.
const knownDates = new Set();

let lastSnapshotDate = null;

const CURRENCY_SYMBOLS = new Map([
  ["EUR", "€"],
  ["USD", "$"],
  ["GBP", "£"],
]);

function snapshotElements() {
  const overlay = document.querySelector(
    '[data-el="portfolio-snapshot-modal"]',
  );
  if (!overlay) return null;
  return {
    overlay,
    date: overlay.querySelector('[data-el="snapshot-date"]'),
    hint: overlay.querySelector('[data-el="snapshot-hint"]'),
    rows: overlay.querySelector('[data-el="snapshot-rows"]'),
    total: overlay.querySelector('[data-el="snapshot-total"]'),
    save: overlay.querySelector('[data-el="snapshot-save"]'),
  };
}

/** Signed amount without a currency suffix; the delta column is native. */
function signedNative(value) {
  return `${value < 0 ? "-" : "+"}${formatAmount(Math.abs(value))}`;
}

function currencySymbol(currency) {
  return CURRENCY_SYMBOLS.get(currency) ?? currency;
}

/**
 * Build one position row. The previous value is the placeholder, so an untouched
 * row shows what carrying forward records; a carried previous value is flagged.
 */
function rowHtml(position) {
  const symbol = escapeHtml(currencySymbol(position.currency));
  const name = escapeHtml(position.name);
  const placeholder =
    position.previous_value === null
      ? ""
      : formatAmount(position.previous_value);
  const stale = position.previous_carried
    ? `<span class="snapshot-row-stale" title="The previous reading was carried forward, not entered — this row compares against a copied value."> · last value carried</span>`
    : "";

  return `
    <div class="snapshot-row" data-position-id="${position.id}">
      <span class="snapshot-cell-name">${name}<span class="snapshot-row-currency"> · ${escapeHtml(
        position.currency,
      )}</span>${stale}</span>
      <label class="snapshot-input snapshot-cell-value">
        <span class="snapshot-input-prefix" aria-hidden="true">${symbol}</span>
        <input type="text" inputmode="decimal" data-field="value"
               aria-label="${name} value" placeholder="${placeholder}" />
      </label>
      <label class="snapshot-input snapshot-cell-deposit">
        <span class="snapshot-input-prefix" aria-hidden="true">${symbol}</span>
        <input type="text" inputmode="decimal" data-field="deposit"
               aria-label="${name} deposit" placeholder="0.00" />
      </label>
      <span class="snapshot-cell-delta"></span>
    </div>
  `;
}

function rowsHtml(depots) {
  return depots
    .map((depot) => {
      const rows = depot.positions.map(rowHtml).join("");
      return `<div class="snapshot-depot">${escapeHtml(depot.name)}</div>${rows}`;
    })
    .join("");
}

function rowElements(row) {
  return {
    position: positions.get(Number(row.dataset.positionId)),
    valueInput: row.querySelector('[data-field="value"]'),
    depositInput: row.querySelector('[data-field="deposit"]'),
    delta: row.querySelector(".snapshot-cell-delta"),
  };
}

/**
 * Recompute one row's delta, `value − previous − deposit`, like the backend's
 * `week_delta`, so a deposit never reads as a gain.
 */
function updateRow(row) {
  const { position, valueInput, depositInput, delta } = rowElements(row);
  if (!position) return;

  const value = parseAmountInput(valueInput.value);
  const deposit = parseAmountInput(depositInput.value);
  valueInput.classList.toggle("is-invalid", Number.isNaN(value));
  depositInput.classList.toggle("is-invalid", Number.isNaN(deposit));

  delta.classList.remove("is-gain", "is-loss");
  delta.classList.toggle("is-carried", value === null);

  if (Number.isNaN(value) || Number.isNaN(deposit)) {
    delta.textContent = "—";
    return;
  }
  if (value === null) {
    delta.textContent = position.previous_value === null ? "—" : "carried";
    return;
  }

  const moved = value - (position.previous_value ?? 0) - (deposit ?? 0);
  delta.textContent = signedNative(moved);
  const tone = toneClass(moved);
  if (tone) delta.classList.add(tone);
}

/**
 * Recompute the footer total the portfolio will be worth once saved. A blank row
 * counts its carried value, converted with its last FX rate, as the server does.
 */
function updateTotal() {
  const { rows, total } = snapshotElements();
  let sum = 0;

  for (const row of rows.querySelectorAll(".snapshot-row")) {
    const { position, valueInput } = rowElements(row);
    if (!position) continue;
    const value = parseAmountInput(valueInput.value);
    const effective =
      value === null || Number.isNaN(value) ? position.previous_value : value;
    sum += (effective ?? 0) / (position.previous_fx_rate ?? 1);
  }

  total.textContent = formatEuro(sum);
}

function baseHint() {
  if (!lastSnapshotDate)
    return "Leave a field empty to carry the previous value forward.";
  return `Last snapshot ${formatDateDots(
    lastSnapshotDate,
  )} · leave a field empty to carry the previous value forward.`;
}

/**
 * Warn, without blocking, when the chosen date already has a snapshot: replacing
 * a week is usually intended, so no confirm dialog.
 */
function syncDateHint() {
  const { date, hint, save } = snapshotElements();
  const replaces = knownDates.has(date.value);

  hint.classList.toggle("is-warning", replaces);
  hint.textContent = replaces
    ? `A snapshot for ${formatDateDots(date.value)} already exists — saving replaces it.`
    : baseHint();
  save.textContent = replaces ? "Replace snapshot" : "Save snapshot";
}

/** Take over a prefill payload and return how many positions it holds. */
function applyPrefill(payload) {
  const { date, rows } = snapshotElements();

  positions.clear();
  knownDates.clear();
  lastSnapshotDate = payload.last_snapshot_date;
  payload.snapshot_dates.forEach((snapshotDate) =>
    knownDates.add(snapshotDate),
  );

  const depots = payload.depots.filter((depot) => depot.positions.length > 0);
  depots.forEach((depot) => {
    depot.positions.forEach((position) => {
      positions.set(position.id, position);
    });
  });

  rows.innerHTML = rowsHtml(depots);

  // The suggestion (last snapshot + a week) may lie in the future, which the
  // POST rejects.
  const today = todayIso();
  date.max = today;
  date.value = payload.suggested_date > today ? today : payload.suggested_date;

  rows.querySelectorAll(".snapshot-row").forEach(updateRow);
  updateTotal();
  syncDateHint();
  return positions.size;
}

/** Load the prefill; with no positions, hand over to the position dialog. */
async function loadPrefill() {
  const { rows } = snapshotElements();
  rows.innerHTML =
    '<div class="snapshot-loading"><div class="spinner"></div></div>';

  try {
    const response = await apiFetch("/api/portfolio/snapshot/new");
    if (!response.ok) throw new Error(`Prefill failed: ${response.status}`);
    const count = applyPrefill(await response.json());
    if (count === 0) {
      closeSnapshotModal();
      openPositionModal();
    }
  } catch (error) {
    console.error("Error loading snapshot prefill:", error);
    closeSnapshotModal();
    showErrorToast("Failed to load positions");
  }
}

/** Open the dialog first, so focus and the spinner land inside it, then fill it. */
export function openSnapshotModal() {
  const elements = snapshotElements();
  if (!elements) return;
  showOverlay(elements.overlay);
  loadPrefill();
}

/** Close the dialog and drop the rows, so a stale list cannot flash. */
export function closeSnapshotModal() {
  const elements = snapshotElements();
  if (!elements) return;
  hideOverlay(elements.overlay);
  elements.rows.innerHTML = "";
  positions.clear();
}

/**
 * Collect the entered rows, or report the first unreadable field. A first
 * snapshot needs a value, caught here so the field can be named.
 */
function collectRows() {
  const { rows } = snapshotElements();

  const payload = [];
  for (const row of rows.querySelectorAll(".snapshot-row")) {
    const { position, valueInput, depositInput } = rowElements(row);
    if (!position) continue;

    const value = parseAmountInput(valueInput.value);
    const deposit = parseAmountInput(depositInput.value);
    if (Number.isNaN(value))
      return { error: "Enter a valid value", field: valueInput };
    if (Number.isNaN(deposit))
      return { error: "Enter a valid deposit", field: depositInput };
    if (value === null && position.previous_value === null)
      return {
        error: `${position.name} needs a value for its first snapshot`,
        field: valueInput,
      };

    payload.push({ position_id: position.id, value, deposit });
  }
  return { rows: payload };
}

/**
 * Post the form, then reload the view. No optimistic patch: it would duplicate
 * the server's gain arithmetic on the client.
 */
async function saveSnapshot() {
  const { date, save } = snapshotElements();
  if (!date.value) {
    showErrorToast("Pick a date");
    date.focus();
    return;
  }

  const collected = collectRows();
  if (collected.error) {
    showErrorToast(collected.error);
    collected.field.focus();
    return;
  }
  if (collected.rows.length === 0) {
    showErrorToast("No positions to record");
    return;
  }

  await withBusyButton(save, async () => {
    try {
      const response = await sendJson("/api/portfolio/snapshot", "POST", {
        date: date.value,
        rows: collected.rows,
      });
      if (!response.ok) {
        // The dialog stays open; the message names the offending row.
        showErrorToast(await errorMessage(response, "Failed to save snapshot"));
        return;
      }
      closeSnapshotModal();
      await loadPortfolio();
      showNoticeToast("Snapshot saved");
    } catch (error) {
      console.error("Error saving snapshot:", error);
      showErrorToast("Failed to save snapshot");
    }
  });
}

/** Wire the dialog and its triggers; the rows are delegated as they render per open. */
export function setupSnapshotListeners() {
  const elements = snapshotElements();
  if (!elements) return;
  const { overlay, date, rows } = elements;

  document
    .querySelectorAll('[data-action="open-snapshot"]')
    .forEach((button) => button.addEventListener("click", openSnapshotModal));

  overlay
    .querySelector(".modal-close")
    .addEventListener("click", closeSnapshotModal);
  overlay
    .querySelector('[data-action="cancel"]')
    .addEventListener("click", closeSnapshotModal);
  overlay
    .querySelector('[data-action="save-snapshot"]')
    .addEventListener("click", saveSnapshot);

  // Reloads the prefill so a new position appears in the open form.
  overlay
    .querySelector('[data-action="add-position"]')
    .addEventListener("click", () =>
      openPositionModal({ onSaved: loadPrefill }),
    );

  rows.addEventListener("input", (event) => {
    const row = event.target.closest(".snapshot-row");
    if (!row) return;
    updateRow(row);
    updateTotal();
  });

  date.addEventListener("input", syncDateHint);
  date.addEventListener("change", syncDateHint);
}
