/**
 * The position history dialog.
 *
 * What is worth pinning down here is the filtering: the default view lists only
 * the weeks money moved, the sale survives that filter, and flipping to every
 * week is a re-render rather than a second request.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  openHistoryModal,
  setupHistoryListeners,
} from "../../static/js/portfolio-history.js";
import { showErrorToast } from "../../static/js/toast.js";
import { flushUi, jsonResponse } from "./helpers.js";

vi.mock("../../static/js/toast.js", () => ({
  showErrorToast: vi.fn(),
  showNoticeToast: vi.fn(),
}));
vi.mock("../../static/js/modals.js", () => ({
  lockScroll: vi.fn(),
  unlockScroll: vi.fn(),
}));

const markup = `
  <div class="modal-overlay" data-el="portfolio-history-modal">
    <div class="modal">
      <div class="modal-header">
        <button class="modal-close"></button>
      </div>
      <div class="modal-body">
        <p data-el="history-subtitle"></p>
        <div data-el="history-filter">
          <button class="portfolio-history-filter-btn" data-scope="payments" aria-pressed="true"></button>
          <button class="portfolio-history-filter-btn" data-scope="all" aria-pressed="false"></button>
        </div>
        <div data-el="history-list"></div>
      </div>
    </div>
  </div>
`;

function row(date, { deposit = 0, change = null, derived = false } = {}) {
  return {
    date,
    value: 1000,
    deposit,
    fx_rate: 1,
    carried: false,
    derived,
    value_eur: 1000,
    deposit_eur: deposit,
    change,
  };
}

function payload() {
  return {
    position: {
      id: 10,
      name: "MSCI World SRI",
      currency: "EUR",
      closed_at: null,
    },
    rows: [
      row("2026-01-18", { change: 40 }),
      row("2026-01-11", { deposit: 500, change: 20 }),
      row("2026-01-04", { deposit: 1000 }),
    ],
  };
}

/** A response the test resolves by hand, to keep a request in flight. */
function deferredResponse(data) {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = () => settle(jsonResponse(data));
  });
  return { promise, resolve };
}

function list() {
  return document.querySelector('[data-el="history-list"]');
}

/** The listed weeks, skipping the column header that shares the row class. */
function dates() {
  return [
    ...list().querySelectorAll(
      ".portfolio-history-row:not(.portfolio-history-header) .portfolio-history-date",
    ),
  ].map((cell) => cell.textContent.trim());
}

function clickScope(scope) {
  document.querySelector(`[data-scope="${scope}"]`).click();
}

async function open() {
  setupHistoryListeners();
  openHistoryModal(10, "MSCI World SRI");
  await flushUi();
}

describe("position history", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => jsonResponse(payload()));
  });

  it("opens on the position it was given and fetches its weeks", async () => {
    await open();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/portfolio/positions/10/snapshots",
      { signal: expect.any(AbortSignal) },
    );
    expect(
      document.querySelector('[data-el="history-subtitle"]').textContent,
    ).toBe("MSCI World SRI");
    expect(
      document.querySelector(".modal-overlay").classList.contains("active"),
    ).toBe(true);
  });

  it("lists only the weeks money moved by default", async () => {
    await open();

    expect(dates()).toEqual(["11.01.2026", "04.01.2026"]);
  });

  it("switches to every week without fetching again", async () => {
    await open();
    clickScope("all");

    expect(dates()).toEqual(["18.01.2026", "11.01.2026", "04.01.2026"]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-scope="all"]').getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps a sale in the payments view, where the money left", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({
        position: {
          id: 10,
          name: "AMD",
          currency: "EUR",
          closed_at: "2026-01-18",
        },
        rows: [row("2026-01-18", { deposit: -1000, derived: true })],
      }),
    );

    await open();

    expect(list().textContent).toContain("Sale");
    expect(dates()).toHaveLength(1);
  });

  it("says so when a position has no weeks at all", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({
        position: { id: 10, name: "New", currency: "EUR", closed_at: null },
        rows: [],
      }),
    );

    await open();

    expect(list().textContent).toContain("No weeks recorded yet");
  });

  it("distinguishes a position without payments from one without weeks", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({
        position: { id: 10, name: "New", currency: "EUR", closed_at: null },
        rows: [row("2026-01-04")],
      }),
    );

    await open();

    expect(list().textContent).toContain("No payments recorded");
  });

  it("reports a refused request instead of leaving the spinner up", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({}, { ok: false, status: 500 }),
    );

    await open();

    expect(showErrorToast).toHaveBeenCalledWith("Failed to load history");
    expect(list().innerHTML).toBe("");
  });

  it("reopens on the payments view after the filter was switched", async () => {
    await open();
    clickScope("all");
    await open();

    expect(dates()).toEqual(["11.01.2026", "04.01.2026"]);
    expect(
      document
        .querySelector('[data-scope="payments"]')
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  // The fetch double ignores `signal`, so an aborted request still resolves
  // here: what these two pin is the identity guard behind the abort.
  it("drops a slow reply once another position was opened", async () => {
    const slow = deferredResponse({
      position: { id: 10, name: "Apple", currency: "USD", closed_at: null },
      rows: [row("2026-02-01", { deposit: 900 })],
    });
    global.fetch = vi.fn(async (url) =>
      url.includes("/10/") ? slow.promise : jsonResponse(payload()),
    );

    setupHistoryListeners();
    openHistoryModal(10, "Apple");
    openHistoryModal(11, "MSCI World SRI");
    await flushUi();
    slow.resolve();
    await flushUi();

    expect(dates()).toEqual(["11.01.2026", "04.01.2026"]);
    expect(list().querySelector(".portfolio-history-native")).toBeNull();
  });

  it("keeps the spinner when the filter is switched mid-load", async () => {
    const pending = deferredResponse(payload());
    global.fetch = vi.fn(async () => pending.promise);

    setupHistoryListeners();
    openHistoryModal(10, "MSCI World SRI");
    await flushUi();
    clickScope("all");

    expect(list().querySelector(".spinner")).not.toBeNull();
    expect(list().textContent).not.toContain("No weeks recorded yet");
    expect(list().textContent).not.toContain("No payments recorded");
  });

  it("stays quiet about a request the user closed the dialog on", async () => {
    const pending = deferredResponse({});
    global.fetch = vi.fn(async () => pending.promise);

    setupHistoryListeners();
    openHistoryModal(10, "MSCI World SRI");
    await flushUi();
    document.querySelector(".modal-close").click();
    pending.resolve();
    await flushUi();

    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("closes on the one button it has", async () => {
    await open();
    document.querySelector(".modal-close").click();

    expect(
      document.querySelector(".modal-overlay").classList.contains("active"),
    ).toBe(false);
  });
});
