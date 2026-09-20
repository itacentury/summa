/**
 * Settings dialog: a container for app-level preferences — the sign-out control
 * moved out of the sidebar, and the portfolio section whose own module fills and
 * wires it.
 */

import { lockScroll, unlockScroll } from "./modals.js";
import {
  refreshPortfolioSettings,
  setupPortfolioSettings,
} from "./settings-portfolio.js";

export function openSettingsModal() {
  const modal = document.querySelector('[data-el="settings-modal"]');
  modal.classList.add("active");
  lockScroll();
  // Deliberately not awaited: the dialog is usable while its sub-lines fill in,
  // and the module reports its own failures.
  refreshPortfolioSettings();
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
  setupPortfolioSettings();
}
