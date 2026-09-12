/**
 * JSON file import flow: staging files, previewing them in the textarea and
 * sending them to the import endpoint.
 */

import { state } from "./state.js";
import { escapeHtml, todayIso } from "./dom.js";
import { showNoticeToast, showErrorToast } from "./toast.js";
import { refreshAllData } from "./api.js";
import { closeImportModal } from "./modals.js";
import { apiFetch } from "./http.js";

export function handleMultipleFiles(files) {
  state.pendingFiles = Array.from(files).filter((f) =>
    f.name.endsWith(".json"),
  );
  updateSelectedFilesDisplay();

  // If files were selected, load them all into the textarea
  if (state.pendingFiles.length > 0) {
    loadFilesIntoTextarea();
  }
}

function updateSelectedFilesDisplay() {
  const container = document.querySelector('[data-el="selected-files"]');
  if (state.pendingFiles.length === 0) {
    container.classList.add("is-hidden");
    return;
  }

  container.classList.remove("is-hidden");
  container.innerHTML = `
        <div class="selected-files-card">
            <div class="selected-files-title">
                ${state.pendingFiles.length} file(s) selected
            </div>
            ${state.pendingFiles
              .map(
                (f, i) => `
                <div class="selected-file-row">
                    <span class="selected-file-name">📄 ${escapeHtml(
                      f.name,
                    )}</span>
                    <button type="button" class="btn btn-danger btn-sm selected-file-remove" data-action="remove-file" data-index="${i}">✕</button>
                </div>
            `,
              )
              .join("")}
        </div>
    `;
}

export function removeFile(index) {
  state.pendingFiles.splice(index, 1);
  updateSelectedFilesDisplay();
  loadFilesIntoTextarea();
}

/**
 * Wire the dropzone, the file picker and the staged-file remove buttons (the
 * latter via delegation, since the file list is rebuilt at runtime).
 */
export function setupImportListeners() {
  const dropzone = document.querySelector('[data-el="dropzone"]');
  const fileInput = document.querySelector('[data-el="file-input"]');

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
    const files = event.dataTransfer.files;
    if (files.length > 0) handleMultipleFiles(files);
  });
  fileInput.addEventListener("change", (event) => {
    if (event.target.files.length > 0) handleMultipleFiles(event.target.files);
  });

  document
    .querySelector('[data-el="selected-files"]')
    .addEventListener("click", (event) => {
      const removeButton = event.target.closest('[data-action="remove-file"]');
      if (removeButton) removeFile(Number(removeButton.dataset.index));
    });

  // Error-card actions are rebuilt at runtime, so delegate from the container.
  document
    .querySelector('[data-el="import-errors"]')
    .addEventListener("click", (event) => {
      if (event.target.closest('[data-action="reimport-corrected"]')) {
        reimportCorrected();
      } else if (event.target.closest('[data-action="download-invalid"]')) {
        downloadInvalid();
      }
    });
}

async function loadFilesIntoTextarea() {
  if (state.pendingFiles.length === 0) {
    document.querySelector('[data-el="json-input"]').value = "";
    return;
  }

  const allData = [];

  for (const file of state.pendingFiles) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        allData.push(...parsed);
      } else {
        allData.push(parsed);
      }
    } catch {
      showErrorToast(`Failed to read ${file.name}`);
    }
  }

  document.querySelector('[data-el="json-input"]').value = JSON.stringify(
    allData,
    null,
    2,
  );
}

// Cap the inline editor cards so a huge failure set stays scannable; the rest
// are reachable via the download, which always exports every invalid entry.
const MAX_VISIBLE_ERRORS = 20;

export async function importJson() {
  const jsonText = document
    .querySelector('[data-el="json-input"]')
    .value.trim();
  if (!jsonText) {
    showErrorToast("Please enter JSON data");
    return;
  }

  let data;
  try {
    data = JSON.parse(jsonText);
    if (!Array.isArray(data)) data = [data];
  } catch {
    showErrorToast("Invalid JSON format");
    return;
  }

  await sendImport(data);
}

/**
 * POST invoice payloads to the import endpoint and report the outcome. Shared by
 * the initial import and the re-import of corrected entries: on partial success
 * the valid rows land and the failed entries are rendered as editable cards.
 *
 * :param originalIndices: on a re-import, maps each re-sent entry's position back
 *     to its original position in the merged upload (all selected files
 *     concatenated), so the re-rendered `#index` badge keeps that upload number
 *     instead of resetting to the 0-based sub-batch. Null on initial import.
 *     It also selects the spinner target: the footer Import button on the initial
 *     import, the "Re-import corrected" button on a re-import. All import triggers
 *     are disabled during the request to block a concurrent import.
 */
async function sendImport(data, originalIndices = null) {
  const footerButton = document.querySelector(
    '[data-el="import-modal"] .modal-footer .btn-primary',
  );
  // Null on the initial import — the error cards (and their re-import button)
  // only exist after a partial failure has been rendered.
  const reimportButton = document.querySelector(
    '[data-action="reimport-corrected"]',
  );
  const guardedButtons = [footerButton, reimportButton].filter(Boolean);

  // Initial import spins the footer Import button; a re-import spins the
  // "Re-import corrected" button. originalIndices distinguishes the two.
  const spinnerTarget = originalIndices ? reimportButton : footerButton;

  const originalContent = spinnerTarget.innerHTML;
  spinnerTarget.innerHTML = '<div class="spinner"></div>';
  for (const guarded of guardedButtons) guarded.disabled = true;

  try {
    const response = await apiFetch("/api/invoices/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    const result = await response.json();

    // A non-array payload (400) or a DB error (500) has no partial semantics.
    if (!response.ok || !result.success) {
      showErrorToast(result.error || "Import failed");
      return;
    }

    let message = `${result.imported} invoice(s) imported`;
    if (result.skipped > 0) {
      message += `, ${result.skipped} duplicate(s) skipped`;
    }
    if (result.failed > 0) {
      message += `, ${result.failed} failed`;
    }
    if (result.failed > 0) showErrorToast(message);
    else showNoticeToast(message);

    // Valid entries always landed, so refresh the list regardless of failures.
    refreshAllData();

    if (result.failed > 0) {
      const errors = originalIndices
        ? result.errors.map((error) => ({
            ...error,
            index: originalIndices[error.index],
          }))
        : result.errors;
      renderImportErrors(errors);
    } else {
      closeImportModal();
    }
  } catch {
    showErrorToast("Import failed");
  } finally {
    spinnerTarget.innerHTML = originalContent;
    for (const guarded of guardedButtons) guarded.disabled = false;
  }
}

/**
 * Render the invalid entries as per-entry editor cards. The full set is stashed on
 * state for download; only the first MAX_VISIBLE_ERRORS are shown as editable
 * cards, with a "+N more" note pointing at the download for the remainder.
 */
function renderImportErrors(errors) {
  state.importErrors = errors;
  const container = document.querySelector('[data-el="import-errors"]');

  const visible = errors.slice(0, MAX_VISIBLE_ERRORS);
  const hiddenCount = errors.length - visible.length;

  const cards = visible
    .map((error) => {
      const fieldLabel = error.field ? `${escapeHtml(error.field)}: ` : "";
      // Entities in the textarea body decode back to the raw JSON on parse, and
      // escaping prevents a value containing `</textarea>` from breaking out.
      const rawJson = escapeHtml(JSON.stringify(error.value, null, 2));
      return `
        <div class="import-error-card">
          <div class="import-error-head">
            <span class="import-error-index">#${error.index + 1}</span>
            <span class="import-error-message">${fieldLabel}${escapeHtml(
              error.message,
            )}</span>
          </div>
          <textarea class="form-input error-editor" data-el="error-editor" data-index="${error.index}">${rawJson}</textarea>
        </div>
      `;
    })
    .join("");

  const moreNote =
    hiddenCount > 0
      ? `<div class="import-error-more">+${hiddenCount} more invalid entr${
          hiddenCount === 1 ? "y" : "ies"
        } — use Download to get them all</div>`
      : "";

  container.innerHTML = `
    <div class="import-error-title">${errors.length} entr${
      errors.length === 1 ? "y" : "ies"
    } failed — fix and re-import, or download</div>
    ${cards}
    ${moreNote}
    <div class="import-error-actions">
      <button type="button" class="btn btn-secondary btn-sm" data-action="download-invalid">Download invalid</button>
      <button type="button" class="btn btn-primary btn-sm" data-action="reimport-corrected">Re-import corrected</button>
    </div>
  `;
  container.classList.remove("is-hidden");
  setImportCorrectionMode(true);
}

/**
 * Toggle import correction mode: hide the fresh-input controls (input wrapper +
 * footer Import) so the only submit path is "Re-import corrected", or restore
 * them. The footer Import would re-send the stale full payload, hence hiding it.
 */
export function setImportCorrectionMode(on) {
  document
    .querySelector('[data-el="import-input"]')
    .classList.toggle("is-hidden", on);
  document
    .querySelector('[data-action="import"]')
    .classList.toggle("is-hidden", on);
}

/**
 * Re-import the full current failure set, applying the edits from the visible
 * error cards. Hidden overflow entries (beyond MAX_VISIBLE_ERRORS) are re-sent
 * unchanged so they survive in state.importErrors instead of being clobbered by
 * the response. This is the current failure set, not the original full payload:
 * already-imported valid rows are not in state.importErrors.
 */
async function reimportCorrected() {
  const editedByIndex = new Map();
  for (const editor of document.querySelectorAll('[data-el="error-editor"]')) {
    try {
      editedByIndex.set(Number(editor.dataset.index), JSON.parse(editor.value));
    } catch {
      showErrorToast(
        `Entry #${Number(editor.dataset.index) + 1}: invalid JSON`,
      );
      return;
    }
  }
  // Built in the same order as `data`, so response position i maps back to the
  // original upload position via originalIndices[i].
  const originalIndices = state.importErrors.map((error) => error.index);
  const data = state.importErrors.map((error) =>
    editedByIndex.has(error.index)
      ? editedByIndex.get(error.index)
      : error.value,
  );
  if (data.length === 0) return;
  await sendImport(data, originalIndices);
}

/**
 * Download every invalid entry (not just the visible cards) as a JSON file.
 */
function downloadInvalid() {
  if (state.importErrors.length === 0) return;
  const entries = state.importErrors.map((error) => error.value);
  const blob = new Blob([JSON.stringify(entries, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const today = todayIso();
  const link = document.createElement("a");
  link.href = url;
  link.download = `invalid-invoices-${today}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
