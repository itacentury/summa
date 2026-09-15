/**
 * The add-position dialog: the only way to create a position, and on a first
 * run a depot along with it.
 *
 * Posts to `POST /api/portfolio/positions`, and to `POST /api/portfolio/depots`
 * first when the depot select is left on its "New depot…" entry. Its depot
 * options come from the snapshot prefill, which is the one endpoint that lists
 * every depot including the empty ones.
 */

import { apiFetch } from "./http.js";
import { showErrorToast, showNoticeToast } from "./toast.js";
import { lockScroll, unlockScroll } from "./modals.js";
import { escapeHtml } from "./dom.js";
import { loadPortfolio } from "./portfolio.js";

// The value marking the "New depot…" entry. Not an id, so it can never collide
// with one.
const NEW_DEPOT = "new";

// What to run after a successful save. The snapshot form sets its own, so a
// position added mid-entry appears in the form the user is still filling in.
let onSaved = null;

/** The dialog's static hooks. */
function positionElements() {
  const overlay = document.querySelector(
    '[data-el="portfolio-position-modal"]',
  );
  if (!overlay) return null;
  return {
    overlay,
    name: overlay.querySelector('[data-el="position-name"]'),
    kind: overlay.querySelector('[data-el="position-kind"]'),
    currency: overlay.querySelector('[data-el="position-currency"]'),
    depot: overlay.querySelector('[data-el="position-depot"]'),
    depotNew: overlay.querySelector('[data-el="position-depot-new"]'),
    depotName: overlay.querySelector('[data-el="position-depot-name"]'),
    save: overlay.querySelector('[data-el="position-save"]'),
  };
}

/** Reveal the new-depot name field exactly while that option is selected. */
function syncDepotChoice() {
  const { depot, depotNew } = positionElements();
  depotNew.classList.toggle("is-hidden", depot.value !== NEW_DEPOT);
}

/**
 * Fill the depot select.
 *
 * The "New depot…" entry is always last and is preselected when there is
 * nothing else to pick — the state a fresh install starts in, where the empty
 * view's "Add first position" is the entry point to the whole area.
 */
function renderDepotOptions(depots) {
  const { depot } = positionElements();
  const options = depots
    .map(
      (entry) =>
        `<option value="${entry.id}">${escapeHtml(entry.name)}</option>`,
    )
    .join("");
  depot.innerHTML = `${options}<option value="${NEW_DEPOT}">New depot…</option>`;
  depot.value = depots.length ? String(depots[0].id) : NEW_DEPOT;
  syncDepotChoice();
}

/** Reset the form to its defaults, so a reopen never shows the last attempt. */
function resetForm() {
  const { name, kind, currency, depotName } = positionElements();
  name.value = "";
  kind.value = "etf";
  currency.value = "EUR";
  depotName.value = "";
}

async function loadDepots() {
  try {
    const response = await apiFetch("/api/portfolio/snapshot/new");
    if (!response.ok) throw new Error(`Depot list failed: ${response.status}`);
    const payload = await response.json();
    renderDepotOptions(payload.depots);
  } catch (error) {
    console.error("Error loading depots:", error);
    renderDepotOptions([]);
  }
}

/**
 * Open the dialog.
 *
 * `onSaved` lets the caller decide what a new position means: the snapshot form
 * reloads its prefill, everything else reloads the view.
 */
export function openPositionModal({ onSaved: handler = null } = {}) {
  const elements = positionElements();
  if (!elements) return;
  onSaved = handler;
  resetForm();
  elements.overlay.classList.add("active");
  lockScroll();
  loadDepots();
}

export function closePositionModal() {
  const elements = positionElements();
  if (!elements) return;
  elements.overlay.classList.remove("active");
  unlockScroll();
}

/**
 * Create the depot the form asks for, or return the selected one.
 *
 * Returns `null` when the server refused, after reporting why — the caller must
 * not fall back to some other depot.
 */
async function resolveDepotId() {
  const { depot, depotName } = positionElements();
  if (depot.value !== NEW_DEPOT) return Number(depot.value);

  const name = depotName.value.trim();
  if (!name) {
    showErrorToast("Enter a depot name");
    depotName.focus();
    return null;
  }

  const response = await apiFetch("/api/portfolio/depots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    showErrorToast(payload.error ?? "Failed to create depot");
    return null;
  }
  return (await response.json()).id;
}

async function savePosition() {
  const { name, kind, currency, save } = positionElements();
  const positionName = name.value.trim();
  if (!positionName) {
    showErrorToast("Enter a position name");
    name.focus();
    return;
  }

  const originalContent = save.innerHTML;
  save.innerHTML = '<div class="spinner"></div>';
  save.disabled = true;
  try {
    const depotId = await resolveDepotId();
    if (depotId === null) return;

    const response = await apiFetch("/api/portfolio/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        depot_id: depotId,
        name: positionName,
        kind: kind.value,
        currency: currency.value.trim().toUpperCase(),
      }),
    });
    if (!response.ok) {
      // Carries the duplicate-name conflict too, which names the position.
      const payload = await response.json().catch(() => ({}));
      showErrorToast(payload.error ?? "Failed to add position");
      return;
    }

    closePositionModal();
    showNoticeToast("Position added");
    await (onSaved ? onSaved() : loadPortfolio());
  } catch (error) {
    console.error("Error adding position:", error);
    showErrorToast("Failed to add position");
  } finally {
    save.innerHTML = originalContent;
    save.disabled = false;
  }
}

/**
 * Wire the dialog and the empty view's trigger. The snapshot form binds its own
 * "Add position" button, because it needs the prefill reloaded afterwards.
 */
export function setupPositionListeners() {
  const elements = positionElements();
  if (!elements) return;
  const { overlay, depot } = elements;

  document
    .querySelectorAll(
      '[data-el="portfolio-empty"] [data-action="add-position"]',
    )
    .forEach((button) =>
      button.addEventListener("click", () => openPositionModal()),
    );

  overlay
    .querySelector(".modal-close")
    .addEventListener("click", closePositionModal);
  overlay
    .querySelector('[data-action="cancel"]')
    .addEventListener("click", closePositionModal);
  overlay
    .querySelector('[data-action="save-position"]')
    .addEventListener("click", savePosition);

  depot.addEventListener("change", syncDepotChoice);
}
