/**
 * Page-size dropdown for the invoice pagination: a custom, accessible listbox
 * (button + floating panel) replacing the native `<select>`, so it looks the
 * same on every platform. Options are 10/25/50/100/All; "All" sends a token the
 * server expands to every matching row on one page.
 *
 * The pagination markup (and this control) is regenerated on every list render,
 * so all interaction is wired via event delegation on the stable
 * `[data-el="pagination"]` container plus a document-level outside-click.
 */

import {
  invoiceState,
  PAGE_SIZE_OPTIONS,
  ALL_PAGE_SIZE,
  PAGE_SIZE_STORAGE_KEY,
} from "./state.js";
import { goToPage } from "./api.js";
import { createFloatingMenu } from "./floating-menu.js";

const ALL_VALUE = "all";

/** The option values in render order, including the "All" sentinel. */
function optionValues() {
  return [...PAGE_SIZE_OPTIONS.map(String), ALL_VALUE];
}

/** The value string matching the current state ("all" or a numeric string). */
function currentValue() {
  return invoiceState.pageSize === ALL_PAGE_SIZE
    ? ALL_VALUE
    : String(invoiceState.pageSize);
}

/** Human label for an option value: "25 / page" for numbers, "All" otherwise. */
function optionLabel(value) {
  return value === ALL_VALUE ? "All" : `${value} / page`;
}

/**
 * Build the page-size control markup. The active option carries `.is-active`
 * plus the checkmark; "All" gets a top divider (via CSS) as the last row.
 */
export function renderPageSizeControl() {
  const active = currentValue();
  const buttonLabel =
    active === ALL_VALUE ? "All" : `${invoiceState.pageSize}<em> / page</em>`;

  const options = optionValues()
    .map((value, index) => {
      const isActive = value === active;
      const allClass = value === ALL_VALUE ? " page-size-option-all" : "";
      const activeClass = isActive ? " is-active" : "";
      return `<li class="page-size-option${allClass}${activeClass}" role="option"
          id="page-size-option-${index}" data-value="${value}"
          aria-selected="${isActive}">
          <span class="page-size-option-label">${optionLabel(value)}</span>
          ${isActive ? '<span class="page-size-check">✓</span>' : ""}
        </li>`;
    })
    .join("");

  return `
    <div class="page-size" data-el="page-size">
      <button type="button" class="page-size-button" data-el="page-size-button"
          role="combobox" aria-label="Invoices per page"
          aria-haspopup="listbox" aria-controls="page-size-menu"
          aria-expanded="false">
        <span class="page-size-value">${buttonLabel}</span>
        <span class="page-size-caret" aria-hidden="true">⌄</span>
      </button>
      <ul class="page-size-menu" id="page-size-menu" role="listbox"
          aria-label="Invoices per page">
        ${options}
      </ul>
    </div>
  `;
}

/** The live control parts, or null when the pagination is not rendered. */
function controlParts() {
  const root = document.querySelector('[data-el="page-size"]');
  if (!root) return null;
  return {
    root,
    button: root.querySelector('[data-el="page-size-button"]'),
    menu: root.querySelector(".page-size-menu"),
    options: [...root.querySelectorAll(".page-size-option")],
  };
}

function isOpen() {
  const root = document.querySelector('[data-el="page-size"]');
  return root !== null && root.classList.contains("is-open");
}

function setHighlight(options, index) {
  options.forEach((option, position) => {
    option.classList.toggle("is-highlighted", position === index);
  });
  const active = options[index];
  const button = document.querySelector('[data-el="page-size-button"]');
  if (active && button) {
    button.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }
}

// The pagination markup is rebuilt on every list render, so the panel this
// anchors is a different element each time the menu opens — hence an instance
// per open rather than one for the module.
let floating = null;

function releaseMenu() {
  if (!floating) return;
  floating.release();
  floating = null;
}

function openMenu() {
  const parts = controlParts();
  if (!parts) return;
  parts.root.classList.add("is-open");
  parts.button.setAttribute("aria-expanded", "true");
  releaseMenu();
  floating = createFloatingMenu(parts.button, parts.menu, { align: "right" });
  floating.place();
  floating.bind();
  // Start the highlight on the active option so keyboard use has a cursor.
  const activeIndex = parts.options.findIndex((option) =>
    option.classList.contains("is-active"),
  );
  setHighlight(parts.options, activeIndex >= 0 ? activeIndex : 0);
}

function closeMenu({ focusButton = false } = {}) {
  releaseMenu();
  const parts = controlParts();
  if (!parts) return;
  parts.root.classList.remove("is-open");
  parts.button.setAttribute("aria-expanded", "false");
  parts.button.removeAttribute("aria-activedescendant");
  parts.options.forEach((option) => option.classList.remove("is-highlighted"));
  if (focusButton) parts.button.focus();
}

/**
 * Commit a chosen option value: update state, persist it, and reload page 1
 * (which re-renders the pagination with the menu closed). Selection is
 * preserved because it uses `goToPage`, not `loadInvoices`.
 */
function selectValue(value) {
  // goToPage replaces the markup this was anchored to, closed.
  releaseMenu();
  invoiceState.pageSize =
    value === ALL_VALUE ? ALL_PAGE_SIZE : parseInt(value, 10);
  localStorage.setItem(PAGE_SIZE_STORAGE_KEY, value);
  goToPage(1);
}

function moveHighlight(delta) {
  const parts = controlParts();
  if (!parts || parts.options.length === 0) return;
  const current = parts.options.findIndex((option) =>
    option.classList.contains("is-highlighted"),
  );
  const start = current < 0 ? 0 : current + delta;
  const next = Math.max(0, Math.min(parts.options.length - 1, start));
  setHighlight(parts.options, next);
}

function highlightedValue() {
  const highlighted = document.querySelector(
    ".page-size-option.is-highlighted",
  );
  return highlighted ? highlighted.dataset.value : null;
}

/**
 * Wire the page-size dropdown once, via delegation on the stable pagination
 * container plus a document-level outside-click. Safe to call before the first
 * render — the handlers resolve the live nodes lazily.
 */
export function setupPageSizeListeners() {
  const container = document.querySelector('[data-el="pagination"]');
  if (!container) return;

  container.addEventListener("click", (event) => {
    const option = event.target.closest(".page-size-option");
    if (option) {
      selectValue(option.dataset.value);
      return;
    }
    if (event.target.closest('[data-el="page-size-button"]')) {
      if (isOpen()) closeMenu();
      else openMenu();
    }
  });

  container.addEventListener("keydown", (event) => {
    if (!event.target.closest('[data-el="page-size"]')) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (isOpen()) moveHighlight(1);
        else openMenu();
        break;
      case "ArrowUp":
        event.preventDefault();
        if (isOpen()) moveHighlight(-1);
        break;
      case "Home":
        if (isOpen()) {
          event.preventDefault();
          moveHighlight(-Infinity);
        }
        break;
      case "End":
        if (isOpen()) {
          event.preventDefault();
          moveHighlight(Infinity);
        }
        break;
      case "Enter":
      case " ": {
        // When closed, let the button's native click open the menu (the click
        // delegate is the single toggle authority) — do not preventDefault, or
        // the synthetic click never fires. When open, commit the highlight.
        if (!isOpen()) break;
        event.preventDefault();
        const value = highlightedValue();
        if (value !== null) selectValue(value);
        break;
      }
      case "Escape":
        if (isOpen()) {
          event.preventDefault();
          closeMenu({ focusButton: true });
        }
        break;
    }
  });

  document.addEventListener("click", (event) => {
    if (isOpen() && !event.target.closest('[data-el="page-size"]')) closeMenu();
  });
}
