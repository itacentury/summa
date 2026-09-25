/**
 * DOM element cache and generic UI utilities.
 *
 * Leaf module: imports nothing from the app so it can be imported anywhere
 * without creating cycles.
 */

/** Shared mobile breakpoint — keep in sync with the CSS `(width <= 640px)` media queries. */
export const mobileViewport = window.matchMedia("(width <= 640px)");

// Slots in the chart palette: the --chart-1…8 tokens in variables.css.
export const CHART_PALETTE_SIZE = 8;

/**
 * Return the chart palette in donut/bar order, read from the `--chart-N` tokens
 * so variables.css stays its only definition.
 */
export function chartColors() {
  const root = getComputedStyle(document.documentElement);
  return Array.from({ length: CHART_PALETTE_SIZE }, (_, index) =>
    root.getPropertyValue(`--chart-${index + 1}`).trim(),
  );
}

let cachedEls = null;

/**
 * Return the cached references to the persistent filter/list elements.
 *
 * Queried lazily on first call (not at import time) so module evaluation never
 * depends on the DOM already being parsed.
 */
export function els() {
  if (!cachedEls) {
    cachedEls = {
      invoiceList: document.querySelector('[data-el="invoice-list"]'),
      searchInput: document.querySelector('[data-el="search"]'),
      storeFilter: document.querySelector('[data-el="store-filter"]'),
      typeFilter: document.querySelector('[data-el="type-filter"]'),
      dateFrom: document.querySelector('[data-el="date-from"]'),
      dateTo: document.querySelector('[data-el="date-to"]'),
      sortBy: document.querySelector('[data-el="sort-by"]'),
      sortOrder: document.querySelector('[data-el="sort-order"]'),
      monthDisplay: document.querySelector('[data-el="month-display"]'),
    };
  }
  return cachedEls;
}

/**
 * Debounce a function so it only runs after `wait` ms of inactivity.
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Parse an ISO date string into a local-time Date.
 *
 * Date-only ISO strings parse as UTC midnight; split the parts so the Date is
 * built in local time and the rendered day can't shift by one. Anything that
 * isn't a bare YYYY-MM-DD (e.g. an imported datetime) falls back to the
 * permissive Date parser.
 */
function parseLocalDate(dateStr) {
  const parts = dateStr.split("-").map(Number);
  return parts.length === 3 && parts.every(Number.isFinite)
    ? new Date(parts[0], parts[1] - 1, parts[2])
    : new Date(dateStr);
}

/**
 * Format an ISO date string as DD/MM/YYYY.
 */
export function formatDate(dateStr) {
  if (!dateStr) return "";
  return parseLocalDate(dateStr).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Format an ISO date string as DD/MM (the compact mobile list variant).
 */
export function formatDateShort(dateStr) {
  if (!dateStr) return "";
  return parseLocalDate(dateStr).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
  });
}

/**
 * Format a Date as a local-time ISO day string (YYYY-MM-DD).
 *
 * The Swedish locale renders as `YYYY-MM-DD HH:mm:ss`, so taking the part
 * before the space yields the date in *local* time — unlike `toISOString()`,
 * which is UTC and can land on the wrong calendar day.
 */
export function dateToIso(date) {
  return date.toLocaleString("sv").split(" ")[0];
}

/**
 * Return today's local date as an ISO day string (YYYY-MM-DD).
 */
export function todayIso() {
  return dateToIso(new Date());
}

// Mirrors `_OVERLONG_YEAR` in `summa/helpers.py`: a year of five or more
// significant digits is past 9999 and so future by definition. A date field
// really can emit one ("275760-09-13"), and those sort *below* a 4-digit year
// as plain strings, so they can't be range-compared. Leading zeros are skipped,
// so only the significant digits decide.
const OVERLONG_YEAR = /^0*[1-9]\d{4,}-/;

/**
 * Whether an ISO day string (YYYY-MM-DD, optionally followed by a time) lies
 * after today. ISO day strings compare correctly as plain strings; an empty
 * value is never future. Reads `todayIso()` at call time so long-lived PWA
 * sessions stay correct across midnight.
 */
export function isFutureIsoDate(value) {
  if (!value) return false;
  if (OVERLONG_YEAR.test(value)) return true;
  // A value whose first `-` isn't at index 4 is not a recognizable ISO day (a
  // zero-padded year, say) — tolerated rather than called future, matching the
  // backend's non-ISO fall-through.
  if (value.indexOf("-") !== 4) return false;
  // Compare only the day part, matching the backend's `date_value[:10]` — a
  // trailing time would otherwise sort today above the bare `todayIso()`.
  return value.slice(0, 10) > todayIso();
}

/**
 * Whether this is Firefox for Android, which greys out a date input's `max` day
 * itself — a cap of today would make today unpickable there. Desktop Firefox is
 * unaffected, hence the Android check; Firefox for iOS ("FxiOS") is a WebKit
 * shell and also fine.
 */
function isAndroidFirefox() {
  const ua = navigator.userAgent;
  return /Android/.test(ua) && /Firefox\//.test(ua);
}

// Built at local noon so a DST shift can't move the calendar day.
function tomorrowIso() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return dateToIso(date);
}

/**
 * Cap a date input's selectable range at today (there are no future invoices).
 * On Firefox for Android the cap is tomorrow instead, so that browser greys out
 * tomorrow rather than today; the one extra day it lets through is still
 * rejected by `isFutureIsoDate` and by the backend.
 *
 * Reads the date at call time so long-lived PWA sessions don't go stale across
 * midnight, when a once-set `max` would still hold yesterday.
 */
export function capAtToday(input) {
  input.max = isAndroidFirefox() ? tomorrowIso() : todayIso();
}

/**
 * Escape text for safe insertion into innerHTML, including HTML attribute
 * values (encodes quotes, unlike the textContent trick).
 */
export function escapeHtml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Return "1 invoice" / "3 invoices": the count with an English regular plural. */
export function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Swap `button` for a disabled spinner while `task` runs, then restore it. */
export async function withBusyButton(button, task) {
  const originalContent = button.innerHTML;
  button.innerHTML = '<div class="spinner"></div>';
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.innerHTML = originalContent;
    button.disabled = false;
  }
}

const CATEGORY_COLOR_SLUGS = {
  technik: "technik",
  sport: "sport",
  lebensmittel: "lebensmittel",
  bäcker: "baecker",
  bäckerei: "baecker",
  restaurant: "baecker",
  unterkunft: "unterkunft",
};

/**
 * Return the background + text color for a category badge.
 *
 * Known categories map to a fixed `--cat-*` pair; anything else is hashed
 * deterministically onto the `--chart-1…8` palette so a given name always keeps
 * the same color. Pure function — only emits CSS-variable references, never the
 * raw category text.
 */
function categoryColorPair(category) {
  const key = category.trim().toLowerCase();
  const mapped = CATEGORY_COLOR_SLUGS[key];
  if (mapped) {
    return { bg: `var(--cat-${mapped})`, text: `var(--cat-${mapped}-text)` };
  }

  let hash = 0;
  for (const char of key) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const index = (hash % 8) + 1;
  return { bg: `var(--chart-${index})`, text: "var(--text-primary)" };
}

/**
 * Paint a category badge's colors via the CSSOM (not a `style` attribute), so a
 * strict `style-src` CSP without `'unsafe-inline'` does not block it.
 */
export function applyCategoryBadge(element, category) {
  const { bg, text } = categoryColorPair(category);
  element.style.background = bg;
  element.style.color = text;
}

/**
 * Return just the themed background color reference for a category (the color
 * dot used by the category combobox). Emits only a `var(--…)` reference, never
 * the raw category text, so the result is safe to inline.
 */
export function categoryColorVar(category) {
  return categoryColorPair(category).bg;
}

/**
 * Format a numeric amount with exactly two decimals (no currency symbol).
 */
export function formatCurrency(amount) {
  return Number(amount).toFixed(2);
}

/**
 * Append the euro symbol to an already formatted amount.
 *
 * The separator is a non-breaking space, so a narrow cell can never wrap the
 * symbol onto its own line. This is the only place the symbol is written in
 * JavaScript — the CSS `::after` rules on the invoice and stats totals are its
 * markup-side counterpart.
 */
export function withEuro(amount) {
  return `${amount}\u00a0€`;
}

/**
 * Get the current search value from the search input.
 */
export function getSearchValue() {
  return document.querySelector('[data-el="search"]')?.value || "";
}
