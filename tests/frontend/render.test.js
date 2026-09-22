import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mountListFixture } from "./helpers.js";

// The page-size control lives in pagesize.js and needs its own DOM; stub it out
// so the render fixture can stay minimal — renderPagination only interpolates
// its string result.
vi.mock("../../static/js/pagesize.js", () => ({
  renderPageSizeControl: () => "",
}));

import {
  captureRows,
  itemRowsHtml,
  reinsertRows,
  renderInvoices,
  restoreRows,
} from "../../static/js/render.js";
import { state, selectedInvoices } from "../../static/js/state.js";

const listEl = () => document.querySelector('[data-el="invoice-list"]');

beforeAll(() => {
  mountListFixture();
});

beforeEach(() => {
  Object.assign(state, {
    invoices: [],
    page: 1,
    effectivePageSize: 25,
    totalCount: 0,
    totalSum: 0,
    uncategorizedCount: 0,
  });
  selectedInvoices.clear();
});

describe("renderInvoices", () => {
  it("renders the empty state when there are no invoices", () => {
    renderInvoices();

    expect(listEl().querySelector(".empty-state")).not.toBeNull();
    expect(listEl().textContent).toContain("No invoices found");
    expect(
      document.querySelector('[data-el="results-count"]').textContent,
    ).toBe("0 invoices");
  });

  it("renders one row per invoice with escaped, formatted fields", () => {
    state.invoices = [
      {
        id: 1,
        date: "2026-01-05",
        store: "<b>Aldi</b>",
        category: "Food",
        total: "12.50",
      },
      { id: 2, date: "2026-02-10", store: "Rewe", category: "", total: "3.00" },
    ];
    state.totalCount = 2;
    state.totalSum = 15.5;
    selectedInvoices.add(1);

    renderInvoices();

    const rows = listEl().querySelectorAll(".invoice-item");
    expect(rows).toHaveLength(2);

    // Store names are escaped, not injected as markup.
    expect(rows[0].querySelector(".invoice-store").textContent).toBe(
      "<b>Aldi</b>",
    );
    expect(rows[0].querySelector(".invoice-store b")).toBeNull();

    expect(rows[0].querySelector(".invoice-date-full").textContent).toBe(
      "05/01/2026",
    );
    expect(rows[0].querySelector(".invoice-total").textContent).toBe("12.50");

    // Selection is reflected on the row and its checkbox.
    expect(rows[0].classList.contains("selected")).toBe(true);
    expect(rows[0].querySelector('input[type="checkbox"]').checked).toBe(true);
    expect(rows[1].classList.contains("selected")).toBe(false);

    // Roving tab stop starts on the first row only.
    expect(rows[0].tabIndex).toBe(0);
    expect(rows[1].tabIndex).toBe(-1);

    expect(
      document.querySelector('[data-el="results-total"]').textContent,
    ).toBe("15.50");
  });

  it("refreshes the AI trigger badge from the rendered invoices", () => {
    // The badge is page-scoped, so every optimistic re-render (not just a server
    // load) must update it. mountListFixture omits the trigger, so add it here.
    const button = document.createElement("button");
    button.dataset.el = "ai-categories-trigger";
    button.innerHTML = '<span data-el="ai-categories-badge"></span>';
    document.body.appendChild(button);

    state.invoices = [
      { id: 1, date: "2026-01-05", store: "Aldi", category: null, total: "1" },
      {
        id: 2,
        date: "2026-01-06",
        store: "Rewe",
        category: "Food",
        total: "2",
      },
      { id: 3, date: "2026-01-07", store: "Lidl", category: null, total: "3" },
    ];
    state.totalCount = 3;

    renderInvoices();

    expect(
      button.querySelector('[data-el="ai-categories-badge"]').textContent,
    ).toBe("2");
    expect(button.classList.contains("is-empty")).toBe(false);

    button.remove();
  });
});

describe("itemRowsHtml", () => {
  it("escapes the item name and formats the price to two decimals", () => {
    const html = itemRowsHtml([{ item_name: "A & B", item_price: "3.5" }]);

    expect(html).toContain("A &amp; B");
    expect(html).toContain("3.50 €");
  });
});

describe("row reconciliation", () => {
  it("captureRows records removed rows with their positions", () => {
    state.invoices = [{ id: 1 }, { id: 2 }, { id: 3 }];

    const captured = captureRows(new Set([2]));

    expect(captured).toEqual([{ invoice: { id: 2 }, index: 1 }]);
  });

  it("reinsertRows restores rows at their captured index and re-adds count/sum", () => {
    state.invoices = [{ id: 1 }, { id: 3 }];
    state.totalCount = 2;
    state.totalSum = 10;

    reinsertRows([{ invoice: { id: 2, total: "5" }, index: 1 }], 2);

    expect(state.invoices.map((invoice) => invoice.id)).toEqual([1, 2, 3]);
    expect(state.totalCount).toBe(5); // 2 existing + 1 reinserted + 2 extra
    expect(state.totalSum).toBe(15);
  });

  it("reinsertRows skips an id a concurrent action already kept", () => {
    state.invoices = [{ id: 1 }, { id: 2 }];
    state.totalCount = 2;
    state.totalSum = 10;

    reinsertRows([{ invoice: { id: 2, total: "5" }, index: 1 }]);

    expect(state.invoices.map((invoice) => invoice.id)).toEqual([1, 2]);
    expect(state.totalCount).toBe(2);
    expect(state.totalSum).toBe(10);
  });

  it("restoreRows replaces a present row and never resurrects a removed one", () => {
    state.invoices = [{ id: 1, store: "New" }];

    restoreRows([
      { id: 1, store: "Old" },
      { id: 9, store: "Ghost" },
    ]);

    expect(state.invoices).toEqual([{ id: 1, store: "Old" }]);
  });
});

// The filter-wide uncategorized count feeds the AI trigger's "N on other pages"
// label, so every optimistic mutation adjusts it and every revert has to give
// back exactly what its forward path took — otherwise the label lies until the
// next list load, which the pending-toast guards can defer indefinitely.
describe("uncategorized count reconciliation", () => {
  it("reinsertRows restores only the uncategorized rows it brings back", () => {
    state.invoices = [];
    state.uncategorizedCount = 1;

    // extraCount rows (off-page bulk selection) stay out: their categories were
    // never known, exactly as their sum was never subtracted.
    reinsertRows(
      [
        { invoice: { id: 1, total: "5", category: null }, index: 0 },
        { invoice: { id: 2, total: "5", category: "Food" }, index: 1 },
      ],
      3,
    );

    expect(state.uncategorizedCount).toBe(2);
  });

  it("reinsertRows counts nothing for an id a concurrent action already kept", () => {
    state.invoices = [{ id: 1, category: null }];
    state.uncategorizedCount = 1;

    reinsertRows([
      { invoice: { id: 1, total: "5", category: null }, index: 0 },
    ]);

    expect(state.uncategorizedCount).toBe(1);
  });

  it("restoreRows gives the count back when the edit had added a category", () => {
    state.invoices = [{ id: 1, category: "Food" }];
    state.uncategorizedCount = 4;

    restoreRows([{ id: 1, category: null }]);

    expect(state.uncategorizedCount).toBe(5);
  });

  it("restoreRows takes the count away when the edit had cleared a category", () => {
    state.invoices = [{ id: 1, category: null }];
    state.uncategorizedCount = 4;

    restoreRows([{ id: 1, category: "Food" }]);

    expect(state.uncategorizedCount).toBe(3);
  });

  it("restoreRows leaves the count alone for a row that is no longer present", () => {
    state.invoices = [{ id: 1, category: "Food" }];
    state.uncategorizedCount = 4;

    // The concurrent action that removed id 9 already accounted for it in its
    // post-edit shape, so undoing the edit must not re-add it.
    restoreRows([{ id: 9, category: null }]);

    expect(state.uncategorizedCount).toBe(4);
  });

  it("clamps at zero when the server count is already behind the page", () => {
    state.invoices = [{ id: 1, category: null }];
    state.uncategorizedCount = 0;

    restoreRows([{ id: 1, category: "Food" }]);

    expect(state.uncategorizedCount).toBe(0);
  });
});
