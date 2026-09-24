/**
 * The Manage editor behind Settings → Portfolio.
 *
 * The rules worth pinning down are the ones a screenshot cannot show: a PATCH
 * carries only the fields that actually changed, a refused write leaves the open
 * form standing with what the user typed, and closing a position is a flag
 * rather than a delete.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  openManageModal,
  setupManageListeners,
} from "../../static/js/portfolio-manage.js";
import { openPositionModal } from "../../static/js/portfolio-position.js";
import { loadPortfolio } from "../../static/js/portfolio.js";
import { showErrorToast } from "../../static/js/toast.js";
import { flushUi, jsonResponse } from "./helpers.js";

vi.mock("../../static/js/portfolio.js", () => ({
  loadPortfolio: vi.fn(async () => {}),
}));
vi.mock("../../static/js/portfolio-position.js", async (importOriginal) => ({
  ...(await importOriginal()),
  openPositionModal: vi.fn(),
}));
vi.mock("../../static/js/toast.js", () => ({
  showErrorToast: vi.fn(),
  showNoticeToast: vi.fn(),
}));
vi.mock("../../static/js/modals.js", () => ({
  showOverlay: (overlay) => overlay.classList.add("active"),
  hideOverlay: (overlay) => overlay.classList.remove("active"),
}));

const markup = `
  <div class="modal-overlay" data-el="portfolio-manage-modal">
    <div class="modal modal-sm">
      <div class="modal-header">
        <h3 data-el="manage-title"></h3>
        <button class="modal-close"></button>
      </div>
      <div class="modal-body">
        <div class="manage-list" data-el="manage-list"></div>
      </div>
      <div class="modal-footer">
        <button data-action="cancel"></button>
        <button data-el="manage-add"></button>
      </div>
    </div>
  </div>
`;

function payload() {
  return {
    depots: [
      {
        id: 1,
        name: "Trade Republic",
        positions: [
          {
            id: 10,
            name: "MSCI World SRI",
            kind: "etf",
            currency: "EUR",
            depot_id: 1,
            closed_at: null,
          },
          {
            id: 11,
            name: "AMD",
            kind: "stock",
            currency: "USD",
            depot_id: 1,
            closed_at: "2026-03-01",
          },
        ],
      },
      { id: 2, name: "Deka", positions: [] },
    ],
  };
}

function list() {
  return document.querySelector('[data-el="manage-list"]');
}

function rows() {
  return [...list().querySelectorAll(".manage-row-name")].map(
    (name) => name.textContent,
  );
}

/** The last call that changed something — every write is followed by a reload. */
function lastWrite() {
  return global.fetch.mock.calls
    .filter(([, options]) => options?.method)
    .at(-1);
}

function clickAction(action, index = 0) {
  list().querySelectorAll(`[data-action="${action}"]`)[index].click();
}

async function open(mode, options = {}) {
  setupManageListeners();
  openManageModal(mode, options);
  await flushUi();
}

describe("manage editor", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => jsonResponse(payload()));
  });

  it("lists the depots with their position counts", async () => {
    await open("depots");

    expect(document.querySelector('[data-el="manage-title"]').textContent).toBe(
      "Depots",
    );
    expect(rows()).toEqual(["Trade Republic", "Deka"]);
    expect(list().textContent).toContain("2 positions");
    expect(list().textContent).toContain("0 positions");
  });

  it("lists every position, marking the sold ones", async () => {
    await open("positions");

    expect(rows()).toEqual(["MSCI World SRI", "AMD"]);
    expect(list().textContent).toContain("Stock · USD · Trade Republic · sold");
    expect(list().querySelectorAll(".manage-row.is-closed")).toHaveLength(1);
  });

  it("renames a depot", async () => {
    await open("depots");

    clickAction("manage-edit");
    list().querySelector('[data-el="manage-name"]').value = "TR";
    clickAction("manage-save");
    await flushUi();

    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toBe("/api/portfolio/depots/1");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({ name: "TR" });
    expect(loadPortfolio).toHaveBeenCalled();
  });

  it("sends nothing when a rename changes no character", async () => {
    await open("depots");

    clickAction("manage-edit");
    clickAction("manage-save");
    await flushUi();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(list().querySelector(".manage-form")).toBeNull();
  });

  it("keeps the form open when the server refuses the name", async () => {
    await open("depots");
    global.fetch = vi.fn(async () =>
      jsonResponse(
        { error: "A depot named 'Deka' already exists" },
        { ok: false, status: 409 },
      ),
    );

    clickAction("manage-edit");
    list().querySelector('[data-el="manage-name"]').value = "Deka";
    clickAction("manage-save");
    await flushUi();

    expect(showErrorToast).toHaveBeenCalledWith(
      "A depot named 'Deka' already exists",
    );
    expect(list().querySelector('[data-el="manage-name"]').value).toBe("Deka");
  });

  it("patches only the position fields that changed", async () => {
    await open("positions");

    clickAction("manage-edit");
    list().querySelector('[data-el="manage-currency"]').value = "usd";
    list().querySelector('[data-el="manage-depot"]').value = "2";
    clickAction("manage-save");
    await flushUi();

    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toBe("/api/portfolio/positions/10");
    expect(JSON.parse(options.body)).toEqual({
      currency: "USD",
      depot_id: 2,
    });
  });

  it("rejects a currency that is not three letters", async () => {
    await open("positions");

    clickAction("manage-edit");
    list().querySelector('[data-el="manage-currency"]').value = "EU";
    clickAction("manage-save");
    await flushUi();

    expect(showErrorToast).toHaveBeenCalledWith(
      "Enter a three-letter currency code",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("closes an open position and reopens a sold one", async () => {
    await open("positions");

    clickAction("manage-edit");
    clickAction("manage-close");
    await flushUi();
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({
      close: true,
    });

    clickAction("manage-edit", 1);
    clickAction("manage-close");
    await flushUi();
    const [url, options] = lastWrite();
    expect(url).toBe("/api/portfolio/positions/11");
    expect(JSON.parse(options.body)).toEqual({ close: false });
  });

  it("adds a depot from an inline form and reports it upwards", async () => {
    const onChanged = vi.fn(async () => {});
    await open("depots", { onChanged });

    document.querySelector('[data-el="manage-add"]').click();
    list().querySelector('[data-el="manage-name"]').value = "Scalable";
    clickAction("manage-save");
    await flushUi();

    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toBe("/api/portfolio/depots");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ name: "Scalable" });
    // The reload's own payload goes upwards, so the caller need not fetch it again.
    expect(onChanged).toHaveBeenCalledWith(payload().depots);
    expect(
      global.fetch.mock.calls.filter(
        ([url]) => url === "/api/portfolio?range=max",
      ),
    ).toHaveLength(2);
  });

  it("hands adding a position to the dialog that has the fields", async () => {
    await open("positions");

    document.querySelector('[data-el="manage-add"]').click();

    expect(openPositionModal).toHaveBeenCalled();
    expect(list().querySelector(".manage-form")).toBeNull();
  });

  it("closes on the footer button", async () => {
    await open("depots");

    document.querySelector('[data-action="cancel"]').click();

    expect(
      document
        .querySelector('[data-el="portfolio-manage-modal"]')
        .classList.contains("active"),
    ).toBe(false);
  });
});
