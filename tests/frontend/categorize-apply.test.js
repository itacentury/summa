/**
 * Frontend unit tests for applying AI categories end-to-end: the optimistic
 * update must take the applied rows off `state.uncategorizedCount` (the whole
 * filtered set, across pages) and the undo must put them back, so the AI
 * trigger's "N on other pages" label stays honest inside the undo window —
 * before any server reload reconciles it.
 *
 * Separate from categorize.test.js because `els()` (dom.js) caches its hooks on
 * first call: driving renderInvoices needs the invoice-list fixture mounted once
 * for the file, not swapped in per test.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// renderPagination only interpolates this module's string result, and it needs
// a DOM of its own — stub it out (as render.test.js does).
vi.mock("../../static/js/pagesize.js", () => ({
  renderPageSizeControl: () => "",
}));

// The undo toast owns its own DOM; capture the deferred callbacks instead so a
// test can invoke the undo directly. The commit is never run here: it reloads
// from the server, which is exactly the reconcile these assertions must not lean on.
const undoToast = vi.hoisted(() => ({ onUndo: null, onCommit: null }));
vi.mock("../../static/js/toast.js", () => ({
  showUndoToast: vi.fn((message, { onUndo, onCommit }) => {
    undoToast.onUndo = onUndo;
    undoToast.onCommit = onCommit;
  }),
  showErrorToast: vi.fn(),
  flushPendingToast: vi.fn(),
}));

import {
  runAnalysis,
  setupCategorizeListeners,
} from "../../static/js/categorize.js";
import { state, selectedInvoices } from "../../static/js/state.js";

/**
 * The invoice list, the AI trigger and the categorize modal in one body: apply
 * spans all three (it rewrites the rows, re-renders the badge and closes the
 * modal).
 */
function mountFixture() {
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
    <button data-el="ai-categories-trigger">
      <span data-el="ai-categories-badge"></span>
    </button>
    <div data-el="categorize-modal" class="modal-overlay active">
      <button class="modal-close"></button>
      <p data-el="categorize-subtitle"></p>
      <div data-el="categorize-content"></div>
      <div data-el="categorize-footer">
        <span data-el="categorize-summary-text"></span>
        <button data-action="categorize-cancel-footer"></button>
        <button data-action="categorize-apply">
          <span data-el="categorize-apply-count">0</span>
        </button>
      </div>
    </div>
  `;
}

/** Stub both requests runAnalysis makes: the suggest POST and the category list. */
function stubSuggest(suggestResponse, categories = []) {
  const jsonFor = (url) =>
    url.startsWith("/api/invoices/categorize-suggest")
      ? suggestResponse
      : categories;
  vi.stubGlobal(
    "fetch",
    vi.fn((url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(jsonFor(url)),
      }),
    ),
  );
}

/** One suggestion row, shaped like the endpoint's. */
function suggestion(id, category) {
  return {
    invoice_id: id,
    store: "MediaMarkt",
    total: 42.5,
    items: [{ item_name: "Cable", item_price: 42.5 }],
    category,
    is_new: false,
  };
}

const trigger = () =>
  document.querySelector('[data-el="ai-categories-trigger"]');
const badge = () => document.querySelector('[data-el="ai-categories-badge"]');

/** Run the analysis for the current page and confirm every suggested row. */
async function applyAllSuggestions(suggestions) {
  stubSuggest({
    suggestions,
    total: suggestions.length,
    count: suggestions.length,
  });
  await runAnalysis();
  document.querySelector('[data-action="categorize-apply"]').click();
}

beforeAll(() => {
  mountFixture();
  setupCategorizeListeners();
});

beforeEach(() => {
  Object.assign(state, {
    invoices: [
      {
        id: 1,
        date: "2026-01-05",
        store: "MediaMarkt",
        category: null,
        total: "42.50",
      },
      {
        id: 2,
        date: "2026-01-06",
        store: "Rewe",
        category: "Groceries",
        total: "8.00",
      },
      {
        id: 3,
        date: "2026-01-07",
        store: "Aldi",
        category: null,
        total: "12.00",
      },
    ],
    page: 1,
    effectivePageSize: 25,
    totalCount: 3,
    totalSum: 62.5,
    // Five in the filter, two of them on this page: three sit on other pages.
    uncategorizedCount: 5,
  });
  selectedInvoices.clear();
  undoToast.onUndo = null;
  undoToast.onCommit = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyCategories", () => {
  it("takes the applied rows off the filter-wide count", async () => {
    await applyAllSuggestions([
      suggestion(1, "Electronics"),
      suggestion(3, "Groceries"),
    ]);

    expect(state.uncategorizedCount).toBe(3);
    // The label is the reason the count has to be right: it would otherwise
    // still claim the five the server last reported.
    expect(badge().textContent).toBe("0");
    expect(trigger().title).toBe(
      "AI Categories — none on this page, 3 on other pages matching the current filters",
    );
  });

  it("gives the count back when the apply is undone", async () => {
    await applyAllSuggestions([
      suggestion(1, "Electronics"),
      suggestion(3, "Groceries"),
    ]);

    undoToast.onUndo();

    expect(state.uncategorizedCount).toBe(5);
    expect(badge().textContent).toBe("2");
    expect(trigger().title).toBe("AI Categories");
  });
});
