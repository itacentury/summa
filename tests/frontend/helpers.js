/**
 * Shared fixtures for the frontend suite: a minimal `fetch` Response double and
 * the two DOM skeletons the API and render layers query via their `data-el`
 * hooks. `els()` (dom.js) caches on first call, so mount a fixture once per test
 * file and mutate values/state between cases rather than re-mounting.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { dateToIso } from "../../static/js/dom.js";

/**
 * Put the `--chart-N` tokens from variables.css on the root element, as the
 * stylesheet would in the browser, and return them in palette order.
 */
export function applyChartTokens() {
  // Relative to the Vitest root (the repository), where vitest.config.js lives.
  const css = readFileSync(resolve("static/css/variables.css"), "utf8");
  const palette = [...css.matchAll(/--chart-\d+:\s*([^;]+);/g)].map(
    ([, value]) => value.trim(),
  );
  palette.forEach((value, index) =>
    document.documentElement.style.setProperty(`--chart-${index + 1}`, value),
  );
  return palette;
}

/**
 * A stand-in for a `fetch` Response carrying a JSON body. Only the members the
 * app touches (`ok`, `status`, `json()`) are provided.
 */
export function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

/**
 * Mount the persistent filter inputs `els()` and `buildFilterParams()` read.
 * Every control is a plain input so `.value` is directly settable in a test.
 */
export function mountFilterFixture() {
  document.body.innerHTML = `
    <input data-el="search" />
    <input data-el="store-filter" />
    <input data-el="type-filter" />
    <input data-el="date-from" />
    <input data-el="date-to" />
    <input data-el="sort-by" value="date" />
    <input data-el="sort-order" value="desc" />
    <div data-el="month-display"></div>
    <div data-el="invoice-list"></div>
  `;
}

/**
 * Mount the containers `renderInvoices()` (and the pagination / bulk-toolbar
 * sub-renders it calls) write into.
 */
export function mountListFixture() {
  document.body.innerHTML = `
    <div data-el="invoice-list"></div>
    <span data-el="results-count"></span>
    <span data-el="results-total"></span>
    <div data-el="pagination"></div>
    <div data-el="bulk-action-toolbar">
      <button data-action="select-all"></button>
      <span data-el="selected-count"></span>
    </div>
    <label data-el="select-all-checkbox"><input type="checkbox" /></label>
  `;
}

/**
 * Mount the toolbar `setupFilterListeners()` wires up, mirroring the flex-item
 * structure of `.search-filter-group` in templates/partials/filters.html — that
 * child count is what `searchFieldSpace()` encodes as gap counts. Purely
 * presentational descendants (icon SVGs, the search hint) are left out: no
 * selector reaches them and they sit below the measured group.
 *
 * `aiTrigger` reproduces the `{% if ai_suggestions_enabled %}` branch around the
 * AI button: with the flag off the element is absent from the DOM entirely, and
 * every `querySelector` for it returns null. That is the configuration the
 * toolbar's null-guard exists for.
 */
export function mountToolbarFixture({ aiTrigger = true } = {}) {
  const aiTriggerHtml = aiTrigger
    ? '<button class="ai-trigger" data-el="ai-categories-trigger" data-action="open-categorize"></button>'
    : "";
  document.body.innerHTML = `
    <div class="filters-row">
      <div class="quick-filters">
        <button class="quick-filter-btn" data-filter="month"></button>
        <button class="quick-filter-btn" data-filter="year"></button>
      </div>
      <div class="month-navigator">
        <button data-action="nav-prev"></button>
        <div data-el="month-display"></div>
        <button data-action="nav-next"></button>
      </div>
      <button data-action="nav-today"></button>
      <div class="search-filter-group">
        <button data-el="search-toggle-compact" aria-expanded="false"></button>
        <div class="filter-search">
          <input data-el="search" />
          <button data-el="search-close"></button>
        </div>
        ${aiTriggerHtml}
        <button data-el="filters-toggle"><span data-el="filter-badge" hidden></span></button>
      </div>
    </div>
    <button data-action="reset-filters"></button>
    <input data-el="store-filter" />
    <input data-el="type-filter" />
    <input data-el="date-from" />
    <input data-el="date-to" />
    <input data-el="sort-by" value="date" />
    <input data-el="sort-order" value="desc" />
    <div data-el="invoice-list"></div>
  `;
}

/**
 * Yields to the next macrotask so DOM updates from event handlers can settle.
 */
export function flushUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The ISO day `days` away from today. Built at local noon so the Berlin offset
 * can't shift the calendar day.
 */
export function dayOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return dateToIso(date);
}

/**
 * Mount the import modal containers and controls used by import UI tests.
 */
export function mountImportFixture() {
  document.body.innerHTML = `
    <div data-el="import-modal">
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" data-action="import">Import</button>
      </div>
    </div>
    <div data-el="import-input"></div>
    <textarea data-el="json-input"></textarea>
    <div data-el="import-errors" class="is-hidden"></div>
    <div data-el="selected-files"></div>
    <div data-el="dropzone"></div>
    <input data-el="file-input" type="file" />
  `;
}
