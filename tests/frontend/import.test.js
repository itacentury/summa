import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../static/js/toast.js", () => ({
  showNoticeToast: vi.fn(),
  showErrorToast: vi.fn(),
}));
vi.mock("../../static/js/api.js", () => ({ refreshAllData: vi.fn() }));
vi.mock("../../static/js/modals.js", () => ({ closeImportModal: vi.fn() }));

import { importJson, setupImportListeners } from "../../static/js/import.js";
import { flushUi, jsonResponse, mountImportFixture } from "./helpers.js";
import { invoiceState } from "../../static/js/state.js";
import { refreshAllData } from "../../static/js/api.js";
import { closeImportModal } from "../../static/js/modals.js";
import { showErrorToast } from "../../static/js/toast.js";

beforeEach(() => {
  vi.clearAllMocks();
  mountImportFixture();
  invoiceState.pendingFiles = [];
  invoiceState.importErrors = [];
  setupImportListeners();
});

afterEach(() => {
  delete global.fetch;
});

describe("importJson", () => {
  it("keeps a single-line entry's editor tall enough to edit", async () => {
    document.querySelector('[data-el="json-input"]').value = JSON.stringify([
      "garbage",
    ]);

    global.fetch = vi.fn(async () =>
      jsonResponse({
        success: true,
        imported: 0,
        skipped: 0,
        failed: 1,
        errors: [
          {
            index: 0,
            field: null,
            message: "Entry must be an object",
            value: "garbage",
          },
        ],
      }),
    );

    await importJson();

    const editor = document.querySelector('[data-el="error-editor"]');
    expect(editor.getAttribute("rows")).toBe("2");
  });

  it("renders field errors for mixed invalid fields", async () => {
    const payload = {
      date: "",
      store: "",
      total: "abc",
      items: [{ item_name: "", item_price: "abc" }],
    };
    document.querySelector('[data-el="json-input"]').value =
      JSON.stringify(payload);

    global.fetch = vi.fn(async () =>
      jsonResponse({
        success: true,
        imported: 0,
        skipped: 0,
        failed: 4,
        errors: [
          {
            index: 0,
            field: "date",
            message: "Field 'date' cannot be empty",
            value: payload,
          },
          {
            index: 1,
            field: "store",
            message: "Field 'store' cannot be empty",
            value: payload,
          },
          {
            index: 2,
            field: "total",
            message: "Field 'total' must be a number",
            value: payload,
          },
          {
            index: 3,
            field: "item_name",
            message: "Field 'item_name' cannot be empty",
            value: payload,
          },
        ],
      }),
    );

    await importJson();

    const errors = document.querySelector('[data-el="import-errors"]');
    expect(errors.classList.contains("is-hidden")).toBe(false);
    expect(errors.textContent).toContain("date: Field 'date' cannot be empty");
    expect(errors.textContent).toContain(
      "store: Field 'store' cannot be empty",
    );
    expect(errors.textContent).toContain(
      "total: Field 'total' must be a number",
    );
    expect(errors.textContent).toContain(
      "item_name: Field 'item_name' cannot be empty",
    );
    expect(
      document
        .querySelector('[data-el="import-input"]')
        .classList.contains("is-hidden"),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-action="import"]')
        .classList.contains("is-hidden"),
    ).toBe(true);
    expect(refreshAllData).toHaveBeenCalledOnce();
    expect(closeImportModal).not.toHaveBeenCalled();
  });

  it("reimports corrected entries from error editors", async () => {
    const invalid = {
      date: "",
      store: "Shop",
      total: 10,
      items: [{ item_name: "Milk", item_price: 1.5 }],
    };
    const corrected = {
      date: "2024-01-01",
      store: "Shop",
      total: 10,
      items: [{ item_name: "Milk", item_price: 1.5 }],
    };
    document.querySelector('[data-el="json-input"]').value = JSON.stringify([
      invalid,
    ]);

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          imported: 0,
          skipped: 0,
          failed: 1,
          errors: [
            {
              index: 0,
              field: "date",
              message: "Field 'date' cannot be empty",
              value: invalid,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          imported: 1,
          skipped: 0,
          failed: 0,
          errors: [],
        }),
      );

    await importJson();

    const editor = document.querySelector('[data-el="error-editor"]');
    editor.value = JSON.stringify(corrected, null, 2);
    document
      .querySelector('[data-action="reimport-corrected"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await flushUi();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const secondCall = global.fetch.mock.calls[1];
    expect(secondCall[0]).toBe("/api/invoices/import");
    const secondBody = JSON.parse(secondCall[1].body);
    expect(secondBody).toEqual([corrected]);
    expect(closeImportModal).toHaveBeenCalledOnce();
    expect(refreshAllData).toHaveBeenCalledTimes(2);
    expect(showErrorToast).toHaveBeenCalledTimes(1);
  });
});
