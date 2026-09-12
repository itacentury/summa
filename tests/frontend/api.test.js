import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { jsonResponse, mountFilterFixture } from "./helpers.js";

// Isolate api.js from its DOM-touching collaborators: these mocks let the tests
// assert api.js's own logic (state mutation, abort handling, store/category
// fallback) without running the real renderer, toasts, charts or comboboxes.
vi.mock("../../static/js/render.js", () => ({ renderInvoices: vi.fn() }));
vi.mock("../../static/js/stats.js", () => ({ loadStats: vi.fn() }));
vi.mock("../../static/js/filters.js", () => ({ updateFilterBadge: vi.fn() }));
vi.mock("../../static/js/toast.js", () => ({
  showErrorToast: vi.fn(),
  // Default: nothing pending, so fetchInvoices skips the toast-commit branch.
  commitPendingToast: vi.fn(() => false),
  hideUndoToast: vi.fn(),
}));
vi.mock("../../static/js/combobox.js", () => ({
  getCombobox: vi.fn(),
  setCategoryOptions: vi.fn(),
}));

import {
  buildFilterParams,
  fetchFilteredIds,
  fetchInvoiceItems,
  loadCategories,
  loadInvoices,
  loadStores,
  reloadCurrentPage,
} from "../../static/js/api.js";
import { state, selectedInvoices } from "../../static/js/state.js";
import { renderInvoices } from "../../static/js/render.js";
import { showErrorToast, commitPendingToast } from "../../static/js/toast.js";
import { getCombobox, setCategoryOptions } from "../../static/js/combobox.js";
import { updateFilterBadge } from "../../static/js/filters.js";

// A DOMException-like abort rejection, matched by name in fetchInvoices' catch.
const abortError = () =>
  Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
  });

// A stand-in combobox exposing only the members loadStores/loadCategories touch.
const fakeCombobox = (value = "") => ({
  getValue: vi.fn(() => value),
  setValue: vi.fn(),
  setOptions: vi.fn(),
});

beforeAll(() => {
  mountFilterFixture();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(commitPendingToast).mockReturnValue(false);
  Object.assign(state, {
    invoices: [],
    page: 1,
    pageSize: 25,
    effectivePageSize: 25,
    totalCount: 0,
    totalSum: 0,
    currentView: "invoices",
  });
  selectedInvoices.clear();
});

afterEach(() => {
  delete global.fetch;
});

describe("loadInvoices", () => {
  it("populates state from the response and resets to page 1", async () => {
    const invoices = [{ id: 1, store: "Aldi", total: "12.50" }];
    global.fetch = vi.fn(async () =>
      jsonResponse({
        invoices,
        page: 1,
        page_size: 25,
        total_count: 1,
        total_sum: 12.5,
      }),
    );
    state.page = 4;
    selectedInvoices.add(99);

    await loadInvoices();

    expect(selectedInvoices.size).toBe(0);
    expect(state.page).toBe(1);
    expect(state.invoices).toEqual(invoices);
    expect(state.effectivePageSize).toBe(25);
    expect(state.totalCount).toBe(1);
    expect(state.totalSum).toBe(12.5);
    expect(renderInvoices).toHaveBeenCalledOnce();
  });

  it("shows an error toast and leaves the list untouched on a non-ok response", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(null, { ok: false, status: 500 }),
    );

    await loadInvoices();

    expect(showErrorToast).toHaveBeenCalledWith("Failed to load invoices");
    expect(state.invoices).toEqual([]);
    expect(renderInvoices).not.toHaveBeenCalled();
  });

  it("does not let a superseded (aborted) request overwrite the newer one", async () => {
    let call = 0;
    global.fetch = vi.fn((_url, options) => {
      call += 1;
      const isFirst = call === 1;
      const data = {
        invoices: [],
        page: 1,
        page_size: 25,
        total_count: isFirst ? 111 : 222,
        total_sum: 0,
      };
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) return reject(abortError());
        options.signal.addEventListener("abort", () => reject(abortError()));
        // Resolve on a later tick so the second call can abort the first.
        setTimeout(() => resolve(jsonResponse(data)), 0);
      });
    });

    const first = loadInvoices();
    const second = loadInvoices();
    await Promise.all([first, second]);

    expect(state.totalCount).toBe(222);
    expect(showErrorToast).not.toHaveBeenCalled();
  });
});

describe("fetchInvoiceItems", () => {
  it("returns the line items of the requested invoice", async () => {
    const items = [{ item_name: "Milk", item_price: "1.29" }];
    global.fetch = vi.fn(async () => jsonResponse({ id: 7, items }));

    await expect(fetchInvoiceItems(7)).resolves.toEqual(items);
    expect(global.fetch).toHaveBeenCalledWith("/api/invoices/7", {});
  });

  it("throws on a failed request", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(null, { ok: false, status: 404 }),
    );

    await expect(fetchInvoiceItems(7)).rejects.toThrow("Request failed: 404");
  });
});

describe("fetchFilteredIds", () => {
  it("returns the id list for the active filters", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ ids: [1, 2, 3] }));

    await expect(fetchFilteredIds()).resolves.toEqual([1, 2, 3]);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toMatch(/^\/api\/invoices\/ids\?/);
    expect(url).toContain("sort_by=date");
  });
});

describe("reloadCurrentPage", () => {
  it("steps back when the current page no longer exists after a mutation", async () => {
    global.fetch = vi.fn(async (url) => {
      const page = Number(new URL(url, "http://x").searchParams.get("page"));
      return jsonResponse({
        invoices: [],
        page,
        page_size: 25,
        total_count: 10, // -> a single page
        total_sum: 0,
      });
    });
    state.page = 3;

    await reloadCurrentPage();

    expect(state.page).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("loadStores", () => {
  it("jumps to the next store and reloads when the selected one is gone", async () => {
    const store = fakeCombobox("Old Store");
    getCombobox.mockImplementation((name) =>
      name === "store-filter" ? store : null,
    );
    global.fetch = vi.fn(async (url) =>
      jsonResponse(
        url.includes("/api/stores")
          ? ["Aldi", "Rewe"]
          : {
              invoices: [],
              page: 1,
              page_size: 25,
              total_count: 0,
              total_sum: 0,
            },
      ),
    );

    await loadStores();

    expect(store.setOptions).toHaveBeenCalledWith(["Aldi", "Rewe"]);
    expect(store.setValue).toHaveBeenCalledWith("Rewe");
    // The store jump reloads the list (a fetch to /api/invoices).
    expect(
      global.fetch.mock.calls.some(([u]) => u.startsWith("/api/invoices?")),
    ).toBe(true);
  });

  it("clears the stale selection and reloads when no stores remain", async () => {
    const store = fakeCombobox("Old Store");
    getCombobox.mockImplementation((name) =>
      name === "store-filter" ? store : null,
    );
    global.fetch = vi.fn(async (url) =>
      jsonResponse(
        url.includes("/api/stores")
          ? []
          : {
              invoices: [],
              page: 1,
              page_size: 25,
              total_count: 0,
              total_sum: 0,
            },
      ),
    );

    await loadStores();

    expect(store.setValue).toHaveBeenCalledWith("");
    expect(updateFilterBadge).toHaveBeenCalled();
  });
});

describe("loadCategories", () => {
  it("clears the filter and reloads when the selected category disappears", async () => {
    const type = fakeCombobox("Gone");
    getCombobox.mockImplementation((name) =>
      name === "type-filter" ? type : null,
    );
    global.fetch = vi.fn(async (url) =>
      jsonResponse(
        url.includes("/api/categories")
          ? ["Food", "Tech"]
          : {
              invoices: [],
              page: 1,
              page_size: 25,
              total_count: 0,
              total_sum: 0,
            },
      ),
    );

    await loadCategories();

    expect(setCategoryOptions).toHaveBeenCalledWith(["Food", "Tech"]);
    expect(type.setValue).toHaveBeenCalledWith("");
    expect(updateFilterBadge).toHaveBeenCalled();
  });
});

describe("buildFilterParams", () => {
  it("assembles the active filter/search/sort inputs into a query string", () => {
    document.querySelector('[data-el="search"]').value = "milk";
    document.querySelector('[data-el="store-filter"]').value = "Aldi";
    document.querySelector('[data-el="type-filter"]').value = "Food";
    document.querySelector('[data-el="date-from"]').value = "2026-01-01";
    document.querySelector('[data-el="date-to"]').value = "2026-01-31";

    const params = buildFilterParams();

    expect(params.get("search")).toBe("milk");
    expect(params.get("store")).toBe("Aldi");
    expect(params.get("category")).toBe("Food");
    expect(params.get("date_from")).toBe("2026-01-01");
    expect(params.get("date_to")).toBe("2026-01-31");
    expect(params.get("sort_by")).toBe("date");
    expect(params.get("sort_order")).toBe("desc");
  });
});
