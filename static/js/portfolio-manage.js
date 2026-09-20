/**
 * The Manage editor behind both Settings → Portfolio rows.
 *
 * One dialog, two modes: depots are renamed and created here, positions are
 * renamed, reclassified, moved between depots, closed and reopened. Deleting is
 * deliberately absent — a position's history is the portfolio's history, and
 * closing is what "I no longer hold this" means (see `closed_at` in db.py).
 */

import { apiFetch } from "./http.js";
import { showErrorToast, showNoticeToast } from "./toast.js";
import { lockScroll, unlockScroll } from "./modals.js";
import { escapeHtml } from "./dom.js";
import { KIND_LABELS, formatDateDots } from "./portfolio-render.js";
import { loadPortfolio } from "./portfolio.js";
import { openPositionModal } from "./portfolio-position.js";

// Which editor is open, what to tell the caller afterwards, and the payload the
// rows are built from.
let mode = "depots";
let onChanged = null;
let depots = [];
// The row whose inline form is open, `NEW_ENTRY` while one is being added, or
// null. Only ever one: two open forms would each claim to hold the truth about
// a name.
let editingId = null;

// Marks the add form. Not an id, so it can never collide with one.
const NEW_ENTRY = "new";

/** The dialog's static hooks. */
function manageElements() {
  const overlay = document.querySelector('[data-el="portfolio-manage-modal"]');
  if (!overlay) return null;
  return {
    overlay,
    title: overlay.querySelector('[data-el="manage-title"]'),
    list: overlay.querySelector('[data-el="manage-list"]'),
    add: overlay.querySelector('[data-el="manage-add"]'),
  };
}

function allPositions() {
  return depots.flatMap((depot) => depot.positions);
}

function depotNameFor(depotId) {
  return depots.find((depot) => depot.id === depotId)?.name ?? "";
}

function depotOptionsHtml(selectedId) {
  return depots
    .map(
      (depot) =>
        `<option value="${depot.id}"${depot.id === selectedId ? " selected" : ""}>${escapeHtml(
          depot.name,
        )}</option>`,
    )
    .join("");
}

function kindOptionsHtml(selectedKind) {
  return [...KIND_LABELS]
    .map(
      ([value, label]) =>
        `<option value="${value}"${value === selectedKind ? " selected" : ""}>${label}</option>`,
    )
    .join("");
}

/** The form buttons every inline editor ends with. */
function formActionsHtml(id, extra = "") {
  return `
    <div class="manage-form-actions">
      ${extra}
      <button type="button" class="btn btn-secondary btn-sm" data-action="manage-cancel">Cancel</button>
      <button type="button" class="btn btn-primary btn-sm" data-action="manage-save" data-id="${id}">Save</button>
    </div>
  `;
}

function depotFormHtml(depot) {
  return `
    <div class="manage-form">
      <label class="form-group">
        <span class="form-label">Name</span>
        <input type="text" class="form-input" data-el="manage-name" value="${escapeHtml(
          depot ? depot.name : "",
        )}" placeholder="e.g. Trade Republic" data-autofocus />
      </label>
      ${formActionsHtml(depot ? depot.id : NEW_ENTRY)}
    </div>
  `;
}

function positionFormHtml(position) {
  const closeLabel = position.closed_at ? "Reopen" : "Close position";
  const closeButton = `<button type="button" class="btn btn-secondary btn-sm manage-close-btn" data-action="manage-close" data-id="${position.id}">${closeLabel}</button>`;
  return `
    <div class="manage-form">
      <label class="form-group">
        <span class="form-label">Name</span>
        <input type="text" class="form-input" data-el="manage-name" value="${escapeHtml(
          position.name,
        )}" data-autofocus />
      </label>
      <div class="form-row">
        <label class="form-group">
          <span class="form-label">Type</span>
          <select class="form-select" data-el="manage-kind">${kindOptionsHtml(position.kind)}</select>
        </label>
        <label class="form-group">
          <span class="form-label">Currency</span>
          <input type="text" class="form-input" data-el="manage-currency" value="${escapeHtml(
            position.currency,
          )}" maxlength="3" />
        </label>
      </div>
      <label class="form-group">
        <span class="form-label">Depot</span>
        <select class="form-select" data-el="manage-depot">${depotOptionsHtml(position.depot_id)}</select>
      </label>
      ${formActionsHtml(position.id, closeButton)}
    </div>
  `;
}

function rowHtml(id, name, sub, { closed = false } = {}) {
  return `
    <div class="manage-row${closed ? " is-closed" : ""}">
      <div class="manage-row-main">
        <div class="manage-row-name">${escapeHtml(name)}</div>
        <div class="manage-row-sub">${escapeHtml(sub)}</div>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="manage-edit" data-id="${id}">Edit</button>
    </div>
  `;
}

function depotRowsHtml() {
  const addForm = editingId === NEW_ENTRY ? depotFormHtml(null) : "";
  return (
    addForm +
    depots
      .map((depot) => {
        const count = depot.positions.length;
        const sub = `${count} ${count === 1 ? "position" : "positions"}`;
        const row = rowHtml(depot.id, depot.name, sub);
        return editingId === depot.id ? row + depotFormHtml(depot) : row;
      })
      .join("")
  );
}

function positionSub(position) {
  const parts = [
    KIND_LABELS.get(position.kind) ?? position.kind,
    position.currency,
    depotNameFor(position.depot_id),
  ];
  if (position.closed_at) {
    parts.push(`sold ${formatDateDots(position.closed_at)}`);
  }
  return parts.join(" · ");
}

function positionRowsHtml() {
  return allPositions()
    .map((position) => {
      const row = rowHtml(position.id, position.name, positionSub(position), {
        closed: Boolean(position.closed_at),
      });
      return editingId === position.id ? row + positionFormHtml(position) : row;
    })
    .join("");
}

function renderList() {
  const { list } = manageElements();
  const rows = mode === "depots" ? depotRowsHtml() : positionRowsHtml();
  list.innerHTML =
    rows ||
    `<div class="manage-empty">Nothing here yet — use the button below.</div>`;
  list.querySelector("[data-autofocus]")?.focus();
}

/** Refetch and repaint. The payload is the editor's only source of truth. */
async function reload() {
  const { list } = manageElements();
  try {
    const response = await apiFetch("/api/portfolio?range=max");
    if (!response.ok) throw new Error(`Manage list failed: ${response.status}`);
    depots = (await response.json()).depots;
    renderList();
  } catch (error) {
    console.error("Error loading the manage list:", error);
    list.innerHTML = `<div class="manage-empty">Could not load this list.</div>`;
  }
}

/**
 * Apply one write, then repaint everything it could have changed.
 *
 * Returns whether it went through, so a caller can leave the form open on a
 * refusal with what the user typed still in it.
 */
async function sendPatch(url, body, notice) {
  try {
    const response = await apiFetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // Carries the duplicate-name conflict, which names the offending row.
      const payload = await response.json().catch(() => ({}));
      showErrorToast(payload.error ?? "Failed to save");
      return false;
    }
  } catch (error) {
    console.error("Error saving:", error);
    showErrorToast("Failed to save");
    return false;
  }

  showNoticeToast(notice);
  editingId = null;
  await reload();
  await onChanged?.();
  await loadPortfolio();
  return true;
}

/** Collect the open form and send only the fields it actually changed. */
async function saveRow(id) {
  const { list } = manageElements();
  const name = list.querySelector('[data-el="manage-name"]').value.trim();
  if (!name) {
    showErrorToast("Enter a name");
    return;
  }

  if (id === NEW_ENTRY) {
    await addDepot(name);
    return;
  }

  if (mode === "depots") {
    const depot = depots.find((entry) => entry.id === id);
    if (name === depot.name) {
      editingId = null;
      renderList();
      return;
    }
    await sendPatch(`/api/portfolio/depots/${id}`, { name }, "Depot renamed");
    return;
  }

  const position = allPositions().find((entry) => entry.id === id);
  const currency = list
    .querySelector('[data-el="manage-currency"]')
    .value.trim()
    .toUpperCase();
  // Mirrors the server's own rule (_require_currency), so a typo costs no round
  // trip.
  if (!/^[A-Z]{3}$/.test(currency)) {
    showErrorToast("Enter a three-letter currency code");
    return;
  }

  const updates = {};
  if (name !== position.name) updates.name = name;
  const kind = list.querySelector('[data-el="manage-kind"]').value;
  if (kind !== position.kind) updates.kind = kind;
  if (currency !== position.currency) updates.currency = currency;
  const depotId = Number(list.querySelector('[data-el="manage-depot"]').value);
  if (depotId !== position.depot_id) updates.depot_id = depotId;

  if (!Object.keys(updates).length) {
    editingId = null;
    renderList();
    return;
  }
  await sendPatch(
    `/api/portfolio/positions/${id}`,
    updates,
    "Position updated",
  );
}

/** Close a position, or reopen it — the flag is the whole operation. */
async function toggleClosed(id) {
  const position = allPositions().find((entry) => entry.id === id);
  const closing = !position.closed_at;
  await sendPatch(
    `/api/portfolio/positions/${id}`,
    { close: closing },
    closing ? "Position closed" : "Position reopened",
  );
}

/** Create a depot from the name the footer's form asks for. */
async function addDepot(name) {
  try {
    const response = await apiFetch("/api/portfolio/depots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      showErrorToast(payload.error ?? "Failed to create depot");
      return;
    }
  } catch (error) {
    console.error("Error creating depot:", error);
    showErrorToast("Failed to create depot");
    return;
  }

  showNoticeToast("Depot added");
  editingId = null;
  await reload();
  await onChanged?.();
}

/**
 * The footer button: a depot is named in an inline form at the top of the list,
 * while a position needs the fields only the add-position dialog has.
 */
function addEntry() {
  if (mode === "positions") {
    openPositionModal({
      onSaved: async () => {
        await reload();
        await onChanged?.();
        await loadPortfolio();
      },
    });
    return;
  }

  editingId = NEW_ENTRY;
  renderList();
}

export function openManageModal(nextMode, { onChanged: handler = null } = {}) {
  const elements = manageElements();
  if (!elements) return;

  mode = nextMode;
  onChanged = handler;
  editingId = null;
  depots = [];
  elements.title.textContent = mode === "depots" ? "Depots" : "Positions";
  elements.add.textContent = mode === "depots" ? "Add depot" : "Add position";
  elements.list.innerHTML = '<div class="manage-empty">Loading…</div>';
  elements.overlay.classList.add("active");
  lockScroll();
  reload();
}

export function closeManageModal() {
  const elements = manageElements();
  if (!elements) return;
  elements.overlay.classList.remove("active");
  unlockScroll();
}

/**
 * Wire the dialog.
 *
 * The row actions are delegated to the list, which survives every repaint; the
 * rows themselves do not.
 */
export function setupManageListeners() {
  const elements = manageElements();
  if (!elements) return;
  const { overlay, list, add } = elements;

  overlay
    .querySelector(".modal-close")
    .addEventListener("click", closeManageModal);
  overlay
    .querySelector('[data-action="cancel"]')
    .addEventListener("click", closeManageModal);
  add.addEventListener("click", addEntry);

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id =
      button.dataset.id === NEW_ENTRY ? NEW_ENTRY : Number(button.dataset.id);
    if (button.dataset.action === "manage-edit") {
      editingId = id;
      renderList();
      return;
    }
    if (button.dataset.action === "manage-cancel") {
      editingId = null;
      renderList();
      return;
    }
    if (button.dataset.action === "manage-save") saveRow(id);
    if (button.dataset.action === "manage-close") toggleClosed(id);
  });
}
