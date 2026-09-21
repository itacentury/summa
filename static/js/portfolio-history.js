/**
 * The position history dialog: a read-only listing of a position's past weeks.
 *
 * Reads `GET /api/portfolio/positions/<id>/snapshots`, which is the only
 * endpoint serving the weekly rows the rest of the area shows as sums. Nothing
 * here writes — correcting a week stays the snapshot form's job.
 */

import { apiFetch } from "./http.js";
import { showErrorToast } from "./toast.js";
import { lockScroll, unlockScroll } from "./modals.js";
import { historyRowsHtml } from "./portfolio-render.js";

// The rows of the position currently on screen, and how they are filtered.
// Kept here rather than refetched, so flipping the filter costs no round trip.
let rows = [];
let currency = "EUR";
let paymentsOnly = true;
let loading = false;
let controller = null; // aborts the in-flight history request

/** The dialog's static hooks. */
function historyElements() {
  const overlay = document.querySelector('[data-el="portfolio-history-modal"]');
  if (!overlay) return null;
  return {
    overlay,
    subtitle: overlay.querySelector('[data-el="history-subtitle"]'),
    filter: overlay.querySelector('[data-el="history-filter"]'),
    list: overlay.querySelector('[data-el="history-list"]'),
  };
}

/**
 * Re-render the list from what was already fetched.
 *
 * The spinner is a state here rather than markup the opener assigns, because
 * the filter pills stay live behind it: no rows *while loading* means "not here
 * yet", which is not what either of `historyRowsHtml`'s empty wordings says.
 */
function renderRows() {
  const { list } = historyElements();
  list.innerHTML = loading
    ? '<div class="spinner"></div>'
    : historyRowsHtml(rows, { currency, paymentsOnly });
}

/** Mark the active filter pill, the way the chart's period group does. */
function syncFilterButtons() {
  const { filter } = historyElements();
  const active = paymentsOnly ? "payments" : "all";
  filter.querySelectorAll(".portfolio-history-filter-btn").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.scope === active),
    );
  });
}

/**
 * Fetch one position's weeks, aborting whatever was still in flight.
 *
 * The identity check is what keeps a slow reply off a newer position's screen:
 * `rows` and `currency` are module state, so a reply that is no longer the open
 * one would otherwise render its rows under the other position's heading.
 */
async function loadHistory(positionId) {
  const { list } = historyElements();
  controller?.abort();
  controller = new AbortController();
  const current = controller;
  try {
    const response = await apiFetch(
      `/api/portfolio/positions/${positionId}/snapshots`,
      { signal: current.signal },
    );
    if (controller !== current) return;
    if (!response.ok) throw new Error(`History failed: ${response.status}`);
    const payload = await response.json();
    if (controller !== current) return;
    rows = payload.rows;
    currency = payload.position.currency;
    loading = false;
    renderRows();
  } catch (error) {
    if (error.name === "AbortError") return; // superseded or closed
    if (controller !== current) return; // the newer load owns the dialog now
    loading = false;
    console.error("Error loading position history:", error);
    showErrorToast("Failed to load history");
    list.innerHTML = "";
  } finally {
    if (controller === current) controller = null;
  }
}

/**
 * Open the dialog for one position.
 *
 * The name comes from the row that triggered this rather than from the reply,
 * so the heading is right while the rows are still loading.
 */
export function openHistoryModal(positionId, name) {
  const elements = historyElements();
  if (!elements) return;

  rows = [];
  currency = "EUR";
  paymentsOnly = true;
  loading = true;
  syncFilterButtons();
  elements.subtitle.textContent = name;
  renderRows();
  elements.overlay.classList.add("active");
  lockScroll();
  loadHistory(positionId);
}

export function closeHistoryModal() {
  const elements = historyElements();
  if (!elements) return;
  controller?.abort();
  controller = null;
  loading = false;
  elements.overlay.classList.remove("active");
  unlockScroll();
}

/** Wire the dialog. Its trigger is delegated from the positions list. */
export function setupHistoryListeners() {
  const elements = historyElements();
  if (!elements) return;
  const { overlay, filter } = elements;

  // The X is the only close button; Esc and the backdrop are handled centrally
  // (keyboard.js falls back to deactivating an overlay that has no Cancel).
  overlay
    .querySelector(".modal-close")
    .addEventListener("click", closeHistoryModal);

  filter.addEventListener("click", (event) => {
    const button = event.target.closest(".portfolio-history-filter-btn");
    if (!button) return;
    paymentsOnly = button.dataset.scope === "payments";
    syncFilterButtons();
    renderRows();
  });
}
