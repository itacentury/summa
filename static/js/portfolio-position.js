/**
 * The add-position dialog, which can also create a depot on the way. Depot
 * options come from the snapshot prefill, the only endpoint listing empty depots.
 */

import { apiFetch, errorMessage, sendJson } from "./http.js";
import { showErrorToast, showNoticeToast } from "./toast.js";
import { hideOverlay, showOverlay } from "./modals.js";
import { escapeHtml, withBusyButton } from "./dom.js";
import { loadPortfolio } from "./portfolio.js";
import { isCurrencyCode } from "./portfolio-format.js";

// Marks "New depot…"; not an id, so it can never collide with one.
const NEW_DEPOT = "new";

// The snapshot form sets its own, so a new position appears in the open form.
let onSaved = null;

// A depot the server may have created without the client learning its id: the
// response was unreadable or never arrived. A retry looks it up by name instead
// of posting it again, and renames it if the name changed.
let unresolvedDepotName = null;

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

function syncDepotChoice() {
  const { depot, depotNew } = positionElements();
  depotNew.classList.toggle("is-hidden", depot.value !== NEW_DEPOT);
}

/** Fill the depot select; "New depot…" is last and preselected when there are none. */
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

/** Reset the form, so a reopen never shows the last attempt. */
function resetForm() {
  const { name, kind, currency, depotName } = positionElements();
  name.value = "";
  kind.value = "etf";
  currency.value = "EUR";
  depotName.value = "";
  unresolvedDepotName = null;
}

async function fetchDepots() {
  const response = await apiFetch("/api/portfolio/snapshot/new");
  if (!response.ok) throw new Error(`Depot list failed: ${response.status}`);
  return (await response.json()).depots;
}

async function loadDepots() {
  try {
    renderDepotOptions(await fetchDepots());
  } catch (error) {
    console.error("Error loading depots:", error);
    renderDepotOptions([]);
  }
}

/** Open the dialog; `onSaved` replaces the default view reload after a save. */
export function openPositionModal({ onSaved: handler = null } = {}) {
  const elements = positionElements();
  if (!elements) return;
  onSaved = handler;
  resetForm();
  showOverlay(elements.overlay);
  loadDepots();
}

export function closePositionModal() {
  const elements = positionElements();
  if (!elements) return;
  hideOverlay(elements.overlay);
}

/**
 * Send the create request, returning the response or `null` after reporting a
 * refusal. Network errors propagate, so each caller keeps its own failure wording.
 */
async function requestDepot(name) {
  const response = await sendJson("/api/portfolio/depots", "POST", { name });
  if (!response.ok) {
    showErrorToast(await errorMessage(response, "Failed to create depot"));
    return null;
  }
  return response;
}

/** Rename a depot, or return `false` after reporting a refusal. */
async function renameDepot(id, name) {
  const response = await sendJson(`/api/portfolio/depots/${id}`, "PATCH", {
    name,
  });
  if (response.ok) return true;
  // Carries the duplicate-name conflict message.
  showErrorToast(await errorMessage(response, "Failed to rename depot"));
  return false;
}

/**
 * Create a depot, or return `false` after reporting a refusal. The body is left
 * unread, so a caller that needs no id cannot fail on it after the depot exists.
 */
export async function postDepot(name) {
  return (await requestDepot(name)) !== null;
}

/** The id in a create response, or `null` when its body is unreadable. */
async function readDepotId(response) {
  try {
    const { id } = await response.json();
    if (Number.isInteger(id)) return id;
  } catch (error) {
    console.error("Unreadable depot response:", error);
  }
  return null;
}

/** Find a created depot in the depot list by its name, which is unique. */
async function findDepotId(name) {
  const created = (await fetchDepots()).find((entry) => entry.name === name);
  if (!created) throw new Error(`Created depot '${name}' not found`);
  return created.id;
}

/**
 * The depot an earlier attempt may have created, or `null` when it never landed.
 * A depot already offered in the select existed before, so it is never adopted.
 */
async function findUnresolvedDepotId() {
  if (unresolvedDepotName === null) return null;
  const { depot } = positionElements();
  const found = (await fetchDepots()).find(
    (entry) => entry.name === unresolvedDepotName,
  );
  if (found && !depot.querySelector(`option[value="${found.id}"]`)) {
    return found.id;
  }
  unresolvedDepotName = null;
  return null;
}

/** Point the form at a created depot, so a retry never creates it again. */
function selectCreatedDepot(id, name) {
  const { depot } = positionElements();
  const option = document.createElement("option");
  option.value = String(id);
  option.textContent = name;
  depot.querySelector(`option[value="${NEW_DEPOT}"]`).before(option);
  depot.value = String(id);
  syncDepotChoice();
}

/** Create a depot and return its id, or `null` after reporting a refusal. */
async function createDepot(name) {
  let id = await findUnresolvedDepotId();
  if (id === null) {
    // Recorded before sending: a lost response may still mean a created depot.
    unresolvedDepotName = name;
    const response = await requestDepot(name);
    if (response === null) {
      unresolvedDepotName = null;
      return null;
    }
    id = (await readDepotId(response)) ?? (await findDepotId(name));
  }
  if (name !== unresolvedDepotName && !(await renameDepot(id, name))) {
    return null;
  }
  unresolvedDepotName = null;
  selectCreatedDepot(id, name);
  return id;
}

/**
 * Create the depot the form asks for, or return the selected one. `null` means
 * the server refused, and the caller must not fall back to another depot.
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
  return createDepot(name);
}

async function savePosition() {
  const { name, kind, currency, save } = positionElements();
  const positionName = name.value.trim();
  if (!positionName) {
    showErrorToast("Enter a position name");
    name.focus();
    return;
  }

  const code = currency.value.trim().toUpperCase();
  if (!isCurrencyCode(code)) {
    showErrorToast("Enter a three-letter currency code");
    currency.focus();
    return;
  }

  await withBusyButton(save, async () => {
    try {
      const depotId = await resolveDepotId();
      if (depotId === null) return;

      const response = await sendJson("/api/portfolio/positions", "POST", {
        depot_id: depotId,
        name: positionName,
        kind: kind.value,
        currency: code,
      });
      if (!response.ok) {
        // Carries the duplicate-name conflict message too.
        showErrorToast(await errorMessage(response, "Failed to add position"));
        return;
      }

      closePositionModal();
      showNoticeToast("Position added");
      await (onSaved ? onSaved() : loadPortfolio());
    } catch (error) {
      console.error("Error adding position:", error);
      showErrorToast("Failed to add position");
    }
  });
}

/**
 * Wire the dialog and the empty view's trigger. The snapshot form binds its own
 * "Add position" button to reload its prefill afterwards.
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
