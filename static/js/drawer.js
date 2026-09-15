/**
 * Mobile drawer (the sidebar slid in from the left) and the top-bar search
 * toggle. Both only have an effect at <= 640px where the topbar is visible;
 * on desktop the controls are hidden so the listeners simply never fire.
 */

import { lockScroll, unlockScroll } from "./modals.js";
import { els } from "./dom.js";

function openDrawer() {
  document.querySelector(".sidebar").classList.add("open");
  document.body.classList.add("drawer-open");
  document
    .querySelector('[data-el="drawer-toggle"]')
    .setAttribute("aria-expanded", "true");
  lockScroll();
  document.querySelector('[data-el="drawer-close"]').focus();
}

function closeDrawer() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar.classList.contains("open")) return;
  sidebar.classList.remove("open");
  document.body.classList.remove("drawer-open");
  const toggle = document.querySelector('[data-el="drawer-toggle"]');
  toggle.setAttribute("aria-expanded", "false");
  unlockScroll();
  toggle.focus();
}

function setSearchToggleExpanded(expanded) {
  document
    .querySelector('[data-el="search-toggle"]')
    .setAttribute("aria-expanded", String(expanded));
}

function openMobileSearch() {
  document.body.classList.add("mobile-search-open");
  setSearchToggleExpanded(true);
  els().searchInput.focus();
}

export function closeMobileSearch() {
  document.body.classList.remove("mobile-search-open");
  setSearchToggleExpanded(false);
}

function toggleMobileSearch() {
  if (document.body.classList.contains("mobile-search-open")) {
    closeMobileSearch();
  } else {
    openMobileSearch();
  }
}

/**
 * Wire the drawer toggle/close/scrim, the drawer's own action buttons (which
 * close it after acting) and the top-bar search slide-in.
 */
export function setupDrawerListeners() {
  document
    .querySelector('[data-el="drawer-toggle"]')
    .addEventListener("click", openDrawer);
  document
    .querySelector('[data-el="drawer-close"]')
    .addEventListener("click", closeDrawer);
  document
    .querySelector('[data-el="drawer-scrim"]')
    .addEventListener("click", closeDrawer);

  // Navigating or opening a modal from the drawer also dismisses it. The
  // dedicated handlers run on the same click; this only folds the drawer away.
  document.querySelector(".sidebar").addEventListener("click", (event) => {
    const actionable = event.target.closest(
      '.nav-item, [data-action="open-add"], [data-action="open-snapshot"], [data-action="open-import"], [data-action="open-settings"]',
    );
    if (actionable) closeDrawer();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (document.body.classList.contains("drawer-open")) {
      closeDrawer();
    } else if (
      document.body.classList.contains("mobile-search-open") &&
      event.target === els().searchInput
    ) {
      closeMobileSearch();
    } else if (document.body.classList.contains("filter-sheet-open")) {
      // Let an open combobox dropdown inside the sheet win (same rule as the
      // modal Escape handling in keyboard.js); a second Escape closes the sheet.
      if (event.defaultPrevented) return;
      document.querySelector('[data-action="close-filter-sheet"]').click();
    }
  });

  document
    .querySelector('[data-el="search-toggle"]')
    .addEventListener("click", toggleMobileSearch);
  document
    .querySelector('[data-el="search-close"]')
    .addEventListener("click", closeMobileSearch);
}
