/**
 * Settings dialog: a container for app-level preferences, currently holding
 * only the sign-out control moved out of the sidebar.
 */

import { lockScroll, unlockScroll } from "./modals.js";

export function openSettingsModal() {
  const modal = document.querySelector('[data-el="settings-modal"]');
  // The empty state is derived from the rows themselves rather than tracked by
  // whoever reveals them: sign-out is unhidden by setupSignOut() in auth.js,
  // which knows nothing about this dialog, and a future setting only has to
  // carry `data-setting` to be counted here.
  const rows = [...modal.querySelectorAll("[data-setting]")];
  modal.querySelector('[data-el="settings-empty"]').hidden = rows.some(
    (row) => !row.hidden,
  );
  modal.classList.add("active");
  lockScroll();
}

export function closeSettingsModal() {
  document
    .querySelector('[data-el="settings-modal"]')
    .classList.remove("active");
  unlockScroll();
}

/**
 * Wire the settings triggers and the dialog's close button.
 *
 * Backdrop clicks need nothing here: setupModalListeners() closes every overlay
 * through its own ✕ button.
 */
export function setupSettingsListeners() {
  document
    .querySelectorAll('[data-action="open-settings"]')
    .forEach((button) => button.addEventListener("click", openSettingsModal));
  document
    .querySelector('[data-el="settings-modal"] .modal-close')
    .addEventListener("click", closeSettingsModal);
}
