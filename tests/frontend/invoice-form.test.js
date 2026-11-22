/**
 * Frontend unit tests for the price fields of the add/edit invoice form: they
 * share the portfolio's parser, so a German `12,50` reads the same as `12.50`
 * in both the live total and the saved payload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  calculateTotal,
  clearPriceFlagIfResolved,
  flagInvalidPrice,
  itemRowInnerHtml,
  setupItemPriceListeners,
} from "../../static/js/modals.js";
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

  // Save refuses `2,500`, so the total must not show its thousands reading.
  // Typing `1.234,56` passes through `1.234`, so the total alone never flags.
  it("leaves an ambiguous price out of the live total without flagging it", () => {
    mountForm([
      ["Milk", "2,500"],
      ["Bread", "1,5"],
    ]);
    const [ambiguous] = document.querySelectorAll(".item-price");

    calculateTotal();

    const total = document.querySelector('[data-el="calculated-total"]');
    expect(total.textContent).toBe("1.50 €");
    expect(ambiguous.getAttribute("aria-invalid")).not.toBe("true");

    ambiguous.value = "2,5000";
    calculateTotal();

    expect(total.textContent).toBe("4.00 €");
  });

  it("explains a flagged ambiguous price in a linked hint", () => {
    mountForm([
      ["Milk", "2,500"],
      ["Bread", "1,5"],
    ]);
    const [ambiguous, plain] = document.querySelectorAll(".item-price");
    const [hint, plainHint] = document.querySelectorAll(".item-price-error");

    expect(flagInvalidPrice(ambiguous)).toBe(true);
    expect(flagInvalidPrice(plain)).toBe(false);

    expect(ambiguous.getAttribute("aria-invalid")).toBe("true");
    expect(plain.getAttribute("aria-invalid")).toBe("false");
    expect(ambiguous.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).not.toBe(plainHint.id);
    expect(hint.classList.contains("is-hidden")).toBe(false);
    expect(hint.textContent).toBe(
      "Ambiguous: write 2500 for thousands or 2,5000 for three decimals.",
    );
    expect(plainHint.classList.contains("is-hidden")).toBe(true);
    expect(hint.getAttribute("role")).toBe("alert");
  });

  // The toast and the focused field's description already say it; an alert
  // from the hint would make a screen reader repeat it a third time.
  it("flags a price on a refused save without a second alert", async () => {
    mountForm([["Milk", "2,500"]]);
    const price = document.querySelector(".item-price");
    const hint = document.querySelector(".item-price-error");

    await saveInvoice();

    expect(showErrorToast).toHaveBeenCalledTimes(1);
    expect(price.getAttribute("aria-invalid")).toBe("true");
    expect(hint.classList.contains("is-hidden")).toBe(false);
    expect(hint.hasAttribute("role")).toBe(false);

    flagInvalidPrice(price);
    expect(hint.getAttribute("role")).toBe("alert");
  });

  it("clears the flag while typing but never raises it", () => {
    mountForm([["Milk", "2,500"]]);
    const price = document.querySelector(".item-price");
    const hint = document.querySelector(".item-price-error");

    clearPriceFlagIfResolved(price);
    expect(price.getAttribute("aria-invalid")).not.toBe("true");
    expect(hint.classList.contains("is-hidden")).toBe(true);

    flagInvalidPrice(price);
    price.value = "2,5000";
    clearPriceFlagIfResolved(price);

    expect(price.getAttribute("aria-invalid")).toBe("false");
    expect(hint.classList.contains("is-hidden")).toBe(true);
  });

  // The live total drops an unparseable price, so the flag must explain why.
  it("flags an unparseable price the total leaves out", () => {
    mountForm([
      ["Milk", "1,5"],
      ["Bread", "12,5x"],
    ]);
    const [, broken] = document.querySelectorAll(".item-price");
    const [, hint] = document.querySelectorAll(".item-price-error");

    calculateTotal();
    expect(
      document.querySelector('[data-el="calculated-total"]').textContent,
    ).toBe("1.50 €");

    expect(flagInvalidPrice(broken)).toBe(true);
    expect(broken.getAttribute("aria-invalid")).toBe("true");
    expect(hint.classList.contains("is-hidden")).toBe(false);
    expect(hint.textContent).toBe(
      "Invalid price: use digits with , or . as the decimal separator.",
    );
  });

  it("clears an unparseable flag once corrected, never raises it mid-typing", () => {
    mountForm([["Bread", "12"]]);
    const price = document.querySelector(".item-price");
    const hint = document.querySelector(".item-price-error");

    price.value = "12,";
    clearPriceFlagIfResolved(price);
    expect(price.getAttribute("aria-invalid")).not.toBe("true");

    flagInvalidPrice(price);
    expect(price.getAttribute("aria-invalid")).toBe("true");
    price.value = "12,5";
    clearPriceFlagIfResolved(price);

    expect(price.getAttribute("aria-invalid")).toBe("false");
    expect(hint.classList.contains("is-hidden")).toBe(true);
    expect(hint.textContent).toBe("");
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

  it("blocks the save on a priced item without a name", async () => {
    mountForm([
      ["Milk", "1,5"],
      ["", "3,50"],
    ]);

    await saveInvoice();

    expect(sendJson).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith("Missing name for item 2");
    const secondName = document.querySelectorAll(".item-name")[1];
    expect(document.activeElement).toBe(secondName);
  });

  it("still ignores a fully empty row", async () => {
    mountForm([
      ["Milk", "1,5"],
      ["", ""],
    ]);

    await saveInvoice();

    const [, , payload] = vi.mocked(sendJson).mock.calls[0];
    expect(payload.items).toEqual([{ item_name: "Milk", item_price: 1.5 }]);
  });

  // The server strips names before its non-empty check, so a blank-looking
  // name would otherwise surface only as a generic 400.
  it("treats a whitespace-only name like an empty one", async () => {
    mountForm([
      ["Milk", "1,5"],
      ["   ", "2,00"],
    ]);

    await saveInvoice();

    expect(sendJson).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith("Missing name for item 2");
    const secondName = document.querySelectorAll(".item-name")[1];
    expect(document.activeElement).toBe(secondName);
  });

  it("ignores a row with a whitespace-only name and no price", async () => {
    mountForm([
      ["  Milk  ", "1,5"],
      ["   ", ""],
    ]);

    await saveInvoice();

    const [, , payload] = vi.mocked(sendJson).mock.calls[0];
    expect(payload.items).toEqual([{ item_name: "Milk", item_price: 1.5 }]);
  });

  // `1.799` is both 1799 (grouping) and 1.799 (three decimals); saving either
  // reading silently could be off by a factor of 1000.
  it("blocks the save on an ambiguous three-digit price", async () => {
    for (const [text, decimal] of [
      ["1.799", "1.7990"],
      ["1,799", "1,7990"],
    ]) {
      vi.mocked(showErrorToast).mockClear();
      mountForm([["Diesel", text]]);

      await saveInvoice();

      expect(sendJson, text).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledWith(
        `Ambiguous price for "Diesel": write 1799 for thousands or ${decimal} for three decimals`,
      );
      const price = document.querySelector(".item-price");
      expect(document.activeElement).toBe(price);
      expect(price.getAttribute("aria-invalid")).toBe("true");
      const hint = document.querySelector(".item-price-error");
      expect(hint.classList.contains("is-hidden")).toBe(false);
    }
  });

  it("flags an unparseable price when the save refuses it", async () => {
    mountForm([["Bread", "12,5x"]]);

    await saveInvoice();

    expect(sendJson).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith('Invalid price for "Bread"');
    const price = document.querySelector(".item-price");
    expect(document.activeElement).toBe(price);
    expect(price.getAttribute("aria-invalid")).toBe("true");
    const hint = document.querySelector(".item-price-error");
    expect(hint.classList.contains("is-hidden")).toBe(false);
  });

  // The toast's three-decimal suggestion must itself be accepted.
  it("saves the suggested four-digit spelling as three decimals", async () => {
    mountForm([["Diesel", "1,7990"]]);

    await saveInvoice();

    const [, , payload] = vi.mocked(sendJson).mock.calls[0];
    expect(payload.items).toEqual([{ item_name: "Diesel", item_price: 1.799 }]);
  });
});

describe("flagging a price field on leave", () => {
  function mountWired(rows) {
    mountForm(rows);
    setupItemPriceListeners(
      document.querySelector('[data-el="add-invoice-modal"]'),
    );
    return document.querySelector(".item-price");
  }

  const press = (target) =>
    target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  const release = (target) =>
    target.dispatchEvent(new Event("pointerup", { bubbles: true }));
  const leave = (input) =>
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags at once when focus leaves by keyboard", () => {
    const price = mountWired([["Milk", "2,500"]]);

    leave(price);

    expect(price.getAttribute("aria-invalid")).toBe("true");
  });

  // The hint is a new grid row; showing it between mousedown and mouseup
  // moves the pressed button away, and its click is lost.
  it("waits for the press to end before flagging", () => {
    const price = mountWired([
      ["Milk", "2,500"],
      ["Bread", "1,5"],
    ]);
    const [, removeButton] = document.querySelectorAll(
      '[data-action="remove-item"]',
    );
    const hint = document.querySelector(".item-price-error");

    press(removeButton);
    leave(price);

    expect(hint.classList.contains("is-hidden")).toBe(true);

    release(removeButton);
    vi.runAllTimers();

    expect(price.getAttribute("aria-invalid")).toBe("true");
    expect(hint.classList.contains("is-hidden")).toBe(false);
  });

  it("skips the flag when the press removed the field", () => {
    const price = mountWired([
      ["Milk", "2,500"],
      ["Bread", "1,5"],
    ]);
    const [removeButton] = document.querySelectorAll(
      '[data-action="remove-item"]',
    );

    press(removeButton);
    leave(price);
    removeButton.closest(".item-input-row").remove();
    release(document.body);

    expect(() => vi.runAllTimers()).not.toThrow();
    expect(price.getAttribute("aria-invalid")).not.toBe("true");
  });
});
