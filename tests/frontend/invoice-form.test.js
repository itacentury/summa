/**
 * Frontend unit tests for the price fields of the add/edit invoice form: they
 * share the portfolio's parser, so a German `12,50` reads the same as `12.50`
 * in both the live total and the saved payload.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../static/js/http.js", () => ({
  apiFetch: vi.fn(),
  sendJson: vi.fn(),
}));
vi.mock("../../static/js/api.js", () => ({
  fetchInvoiceItems: vi.fn(),
  loadCategories: vi.fn(),
  loadInvoices: vi.fn(),
  loadStores: vi.fn(),
  reloadCurrentPage: vi.fn(),
}));
vi.mock("../../static/js/toast.js", () => ({
  hasPendingToast: vi.fn(() => false),
  showErrorToast: vi.fn(),
  showNoticeToast: vi.fn(),
  showUndoToast: vi.fn(),
}));

import { sendJson } from "../../static/js/http.js";
import { showErrorToast } from "../../static/js/toast.js";
import { calculateTotal, itemRowInnerHtml } from "../../static/js/modals.js";
import { saveInvoice } from "../../static/js/invoices.js";
import { state } from "../../static/js/state.js";
import { todayIso } from "../../static/js/dom.js";

function mountForm(rows) {
  const rowHtml = rows
    .map(
      ([name, price]) =>
        `<div class="item-input-row">${itemRowInnerHtml({ item_name: name, item_price: price })}</div>`,
    )
    .join("");
  document.body.innerHTML = `
    <div data-el="add-invoice-modal">
      <input data-el="invoice-date" value="${todayIso()}" />
      <p class="is-hidden" data-el="invoice-date-error"></p>
      <input data-el="invoice-store" value="Rewe" />
      <input data-el="invoice-type" value="" />
      <div data-el="items-container">${rowHtml}</div>
      <span data-el="calculated-total"></span>
      <button data-action="save"></button>
    </div>
  `;
}

beforeEach(() => {
  state.editingInvoiceId = null;
  vi.mocked(sendJson).mockReset();
  vi.mocked(sendJson).mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.mocked(showErrorToast).mockClear();
});

describe("invoice price fields", () => {
  it("counts a comma decimal in the live total", () => {
    mountForm([
      ["Milk", "12,50"],
      ["Bread", "1.234,5"],
    ]);

    calculateTotal();

    const total = document.querySelector('[data-el="calculated-total"]');
    expect(total.textContent).toBe("1247.00 €");
  });

  it("sends both notations as numbers", async () => {
    mountForm([
      ["Milk", "1,5"],
      ["Bread", "2.25"],
    ]);

    await saveInvoice();

    expect(sendJson).toHaveBeenCalledTimes(1);
    const [url, method, payload] = vi.mocked(sendJson).mock.calls[0];
    expect(url).toBe("/api/invoices");
    expect(method).toBe("POST");
    expect(payload.items).toEqual([
      { item_name: "Milk", item_price: 1.5 },
      { item_name: "Bread", item_price: 2.25 },
    ]);
    expect(payload.total).toBe(3.75);
  });

  it("accepts a price without a leading zero", async () => {
    mountForm([
      ["Kaugummi", ",99"],
      ["Milk", "1,5"],
    ]);

    calculateTotal();
    const total = document.querySelector('[data-el="calculated-total"]');
    expect(total.textContent).toBe("2.49 €");

    await saveInvoice();

    expect(showErrorToast).not.toHaveBeenCalledWith(
      'Invalid price for "Kaugummi"',
    );
    expect(sendJson).toHaveBeenCalledTimes(1);
    const [, , payload] = vi.mocked(sendJson).mock.calls[0];
    expect(payload.items[0]).toEqual({
      item_name: "Kaugummi",
      item_price: 0.99,
    });
  });

  // Edit pre-fills the stored number in JS notation, which the parser would
  // misread (`1.799` as grouping, `1e-7` as invalid) if it re-read it.
  it("keeps an untouched stored price exactly as loaded", async () => {
    mountForm([
      ["Diesel", 1.799],
      ["Sample", 1e-7],
    ]);

    calculateTotal();
    const total = document.querySelector('[data-el="calculated-total"]');
    expect(total.textContent).toBe("1.80\u00a0€");

    await saveInvoice();

    expect(showErrorToast).not.toHaveBeenCalledWith(
      'Invalid price for "Sample"',
    );
    const [, , payload] = vi.mocked(sendJson).mock.calls[0];
    expect(payload.items).toEqual([
      { item_name: "Diesel", item_price: 1.799 },
      { item_name: "Sample", item_price: 1e-7 },
    ]);
    expect(payload.total).toBe(1.799 + 1e-7);
  });

  it("re-parses a stored price once the user edits it", async () => {
    mountForm([["Diesel", 1.799]]);
    document.querySelector(".item-price").value = "2,5";

    await saveInvoice();

    const [, , payload] = vi.mocked(sendJson).mock.calls[0];
    expect(payload.items).toEqual([{ item_name: "Diesel", item_price: 2.5 }]);
  });

  // The pre-fill pads `1.799` to `1.7990` so an edit is never read as 1799.
  it("keeps a stored three-decimal price decimal when the user edits it", async () => {
    mountForm([["Diesel", 1.799]]);
    const price = document.querySelector(".item-price");
    expect(price.value).toBe("1.7990");
    price.value = "1.8990";

    await saveInvoice();

    const [, , payload] = vi.mocked(sendJson).mock.calls[0];
    expect(payload.items).toEqual([{ item_name: "Diesel", item_price: 1.899 }]);
  });

  it("blocks the save on an unparseable price", async () => {
    mountForm([
      ["Milk", "1,5"],
      ["Bread", "abc"],
    ]);

    await saveInvoice();

    expect(sendJson).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith('Invalid price for "Bread"');
    const breadPrice = document.querySelectorAll(".item-price")[1];
    expect(document.activeElement).toBe(breadPrice);
  });

  it("blocks the save on a named item without a price", async () => {
    for (const text of ["", "  "]) {
      vi.mocked(showErrorToast).mockClear();
      mountForm([
        ["Milk", "1,5"],
        ["Bread", text],
      ]);

      await saveInvoice();

      expect(sendJson, JSON.stringify(text)).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledWith('Missing price for "Bread"');
      const breadPrice = document.querySelectorAll(".item-price")[1];
      expect(document.activeElement).toBe(breadPrice);
    }
  });

  // `1.799` is both 1799 (grouping) and 1.799 (three decimals); saving either
  // reading silently could be off by a factor of 1000.
  it("blocks the save on an ambiguous three-digit price", async () => {
    for (const text of ["1.799", "1,799"]) {
      vi.mocked(showErrorToast).mockClear();
      mountForm([["Diesel", text]]);

      await saveInvoice();

      expect(sendJson, text).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledWith(
        'Ambiguous price for "Diesel": write 1799 or 1.799,00 for thousands',
      );
      const price = document.querySelector(".item-price");
      expect(document.activeElement).toBe(price);
    }
  });
});
