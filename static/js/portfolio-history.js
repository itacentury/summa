/**
 * The position history dialog: a read-only listing of a position's past weeks
 * from `GET /api/portfolio/positions/<id>/snapshots`.
 */

import { apiFetch } from "./http.js";
import { showErrorToast } from "./toast.js";
import { hideOverlay, showOverlay } from "./modals.js";
import { historyRowsHtml } from "./portfolio-render.js";

// Kept rather than refetched, so flipping the filter costs no round trip.
let rows = [];
let currency = "EUR";
let paymentsOnly = true;
let status = "ready"; // "loading" | "ready" | "error"
let controller = null; // aborts the in-flight history request

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
 * Re-render the list from what was already fetched. Loading and error are states
 * here because the filter pills stay live behind them.
 */
function renderRows() {
  const { list } = historyElements();
  if (status === "loading") {
    list.innerHTML = '<div class="spinner"></div>';
    return;
  }
  if (status === "error") {
    list.innerHTML =
      '<p class="portfolio-history-empty">History could not be loaded.</p>';
    return;
  }
  list.innerHTML = historyRowsHtml(rows, { currency, paymentsOnly });
}

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
 * Fetch one position's weeks, aborting whatever was still in flight. The
 * identity checks keep a slow reply off a newer position's screen.
 */
async function loadHistory(positionId) {
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
    status = "ready";
    renderRows();
  } catch (error) {
    if (error.name === "AbortError") return; // superseded or closed
    if (controller !== current) return; // the newer load owns the dialog now
    status = "error";
    console.error("Error loading position history:", error);
    showErrorToast("Failed to load history");
    renderRows();
  } finally {
    if (controller === current) controller = null;
  }
}

/** Open the dialog; the name comes from the trigger so the heading shows while loading. */
export function openHistoryModal(positionId, name) {
  const elements = historyElements();
  if (!elements) return;

  rows = [];
  currency = "EUR";
  paymentsOnly = true;
  status = "loading";
  syncFilterButtons();
  elements.subtitle.textContent = name;
  renderRows();
  showOverlay(elements.overlay);
  loadHistory(positionId);
}

export function closeHistoryModal() {
  const elements = historyElements();
  if (!elements) return;
  controller?.abort();
  controller = null;
  status = "ready";
  hideOverlay(elements.overlay);
}

/** Wire the dialog; its trigger is delegated from the positions list. */
export function setupHistoryListeners() {
  const elements = historyElements();
  if (!elements) return;
  const { overlay, filter } = elements;

  // Esc and the backdrop are handled centrally in keyboard.js.
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
