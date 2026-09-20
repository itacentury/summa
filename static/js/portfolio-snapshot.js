/**
 * The weekly snapshot form: the one entry flow the portfolio has.
 *
 * Prefilled from `GET /api/portfolio/snapshot/new` and posted to
 * `POST /api/portfolio/snapshot`. A blank field is never zero — it is the
 * "carry the previous value forward" signal the API expects — so every value
 * travels as `null` rather than a guessed number.
 *
 * The dialog itself needs no registration: `.modal-overlay` / `.modal-sheet` /
 * `.sheet-grabber` give it focus trapping, `inert`, `Esc`, `Ctrl+Enter`,
 * backdrop close and the mobile drag gesture from keyboard.js, modals.js and
 * sheet.js.
 */

import { apiFetch } from "./http.js";
import { showErrorToast, showNoticeToast } from "./toast.js";
import { lockScroll, unlockScroll } from "./modals.js";
import { escapeHtml, todayIso } from "./dom.js";
import {
  formatAmount,
  formatDateDots,
  formatEuroSuffixed,
  parseAmountInput,
  toneClass,
} from "./portfolio-render.js";
import { loadPortfolio } from "./portfolio.js";
import { openPositionModal } from "./portfolio-position.js";

// The prefilled positions of the open form, by id: everything the live delta
// and the footer total need that the DOM does not carry.
const positions = new Map();

// Every date already covered by a snapshot, so re-entering one can announce
// that it replaces rather than adds — including a week older than the newest,
// which is where the replacement is least expected. The server upserts
// silently either way.
const knownDates = new Set();

let lastSnapshotDate = null;

const CURRENCY_SYMBOLS = new Map([
  ["EUR", "€"],
  ["USD", "$"],
  ["GBP", "£"],
]);

/** The dialog's static hooks. Queried per call — the markup never moves. */
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

/** Sign and magnitude without a currency suffix — the delta column is native. */
function signedNative(value) {
  return `${value < 0 ? "-" : "+"}${formatAmount(Math.abs(value))}`;
}

function currencySymbol(currency) {
  return CURRENCY_SYMBOLS.get(currency) ?? currency;
}

/**
 * Build one position row: name, the two inputs, and the delta cell the input
 * handler rewrites.
 *
 * The previous value sits in the value field's placeholder, so leaving the row
 * alone shows what carrying forward will record. When that previous reading was
 * itself carried, the name cell says so: the placeholder and the delta below it
 * then compare against a copy rather than a number anyone entered.
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

/** Build the whole list: one label per depot, then its positions. */
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
 * Recompute one row's delta: `value − previous value − deposit`, in the
 * position's own currency.
 *
 * The subtraction is the same rule the backend's `week_delta` follows, so a
 * deposit never reads as a gain. An untouched row shows `carried` instead of a
 * number — there is no move to report until a value is entered.
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
 * Recompute the footer total: what the portfolio is worth once this form is
 * saved.
 *
 * A blank row contributes the value it carries forward, and each row is
 * converted with the FX rate its last snapshot used — the same rate the server
 * inherits when the field is left empty. Closed positions are absent from the
 * prefill and worth nothing, so the sum is the whole portfolio.
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

  total.textContent = formatEuroSuffixed(sum);
}

/** The neutral sub-line: what the form does when a field is left empty. */
function baseHint() {
  if (!lastSnapshotDate)
    return "Leave a field empty to carry the previous value forward.";
  return `Last snapshot ${formatDateDots(
    lastSnapshotDate,
  )} · leave a field empty to carry the previous value forward.`;
}

/**
 * Warn — without blocking — when the chosen date already has a snapshot.
 *
 * The server upserts per `(position_id, date)`, so re-entering a week replaces
 * it. That is usually what the user wants, which is why this states the
 * consequence in the sub-line and on the button instead of interrupting with a
 * confirm dialog.
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

/**
 * Take over a prefill payload: remember its positions, render the rows and put
 * the date, the hint and the total in their initial state.
 */
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

  // The suggestion is the last snapshot plus a week and can therefore fall in
  // the future, which the POST rejects outright.
  const today = todayIso();
  date.max = today;
  date.value = payload.suggested_date > today ? today : payload.suggested_date;

  rows.querySelectorAll(".snapshot-row").forEach(updateRow);
  updateTotal();
  syncDateHint();
  return positions.size;
}

/**
 * Load the prefill into the open dialog. With no positions at all there is
 * nothing to enter, so the form hands over to the position dialog instead.
 */
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

/**
 * Open the snapshot dialog, then fill it.
 *
 * The overlay is activated first so focus lands on the date field and the
 * spinner is shown inside a real dialog rather than behind the page.
 */
export function openSnapshotModal() {
  const elements = snapshotElements();
  if (!elements) return;
  elements.overlay.classList.add("active");
  lockScroll();
  loadPrefill();
}

/** Close the dialog and drop the rendered rows, so a stale list cannot flash. */
export function closeSnapshotModal() {
  const elements = snapshotElements();
  if (!elements) return;
  elements.overlay.classList.remove("active");
  elements.rows.innerHTML = "";
  positions.clear();
  unlockScroll();
}

/**
 * Collect the entered rows, or report the first field that cannot be read.
 *
 * A position without any history cannot carry anything forward — the server
 * rejects that row — so an empty value is caught here, where it can still name
 * the field.
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
 * Post the form, then reload the view.
 *
 * No optimistic patch: loadPortfolio() leaves the rendered list on screen while
 * it refetches, so the only thing an optimistic pass would add is a second,
 * client-side implementation of the server's gain arithmetic.
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

  const originalContent = save.innerHTML;
  save.innerHTML = '<div class="spinner"></div>';
  save.disabled = true;
  try {
    const response = await apiFetch("/api/portfolio/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: date.value, rows: collected.rows }),
    });
    if (!response.ok) {
      // The dialog stays open: the server's message names the offending row,
      // and re-entering the whole week would be the alternative.
      const payload = await response.json().catch(() => ({}));
      showErrorToast(payload.error ?? "Failed to save snapshot");
      return;
    }
    closeSnapshotModal();
    await loadPortfolio();
    showNoticeToast("Snapshot saved");
  } catch (error) {
    console.error("Error saving snapshot:", error);
    showErrorToast("Failed to save snapshot");
  } finally {
    save.innerHTML = originalContent;
    save.disabled = false;
  }
}

/**
 * Wire the dialog and every trigger that opens it (toolbar button and mobile
 * FAB). The rows are delegated — they are rendered per open.
 */
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

  // The dialog's own add-position trigger: a new position has to appear in the
  // form the user is still filling in, so the prefill is reloaded on success.
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
