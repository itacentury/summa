/**
 * The weekly snapshot form and the add-position dialog.
 *
 * The rules worth pinning down are the ones the server cannot express: a blank
 * field travels as `null` (carry forward) rather than a guessed zero, the delta
 * subtracts the deposit so money paid in never reads as a gain, and a date that
 * already has a snapshot says so before it replaces one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  openSnapshotModal,
  setupSnapshotListeners,
} from "../../static/js/portfolio-snapshot.js";
import { setupPositionListeners } from "../../static/js/portfolio-position.js";
import { parseAmountInput } from "../../static/js/portfolio-render.js";
import { loadPortfolio } from "../../static/js/portfolio.js";
import { showErrorToast, showNoticeToast } from "../../static/js/toast.js";
import { todayIso } from "../../static/js/dom.js";
import { flushUi, jsonResponse } from "./helpers.js";

vi.mock("../../static/js/portfolio.js", () => ({
  loadPortfolio: vi.fn(async () => {}),
}));
vi.mock("../../static/js/toast.js", () => ({
  showErrorToast: vi.fn(),
  showNoticeToast: vi.fn(),
}));
vi.mock("../../static/js/modals.js", () => ({
  lockScroll: vi.fn(),
  unlockScroll: vi.fn(),
}));

const markup = `
  <div class="portfolio-view">
    <button data-action="open-snapshot"></button>
    <div data-el="portfolio-empty">
      <button data-action="add-position"></button>
    </div>
  </div>
  <div class="modal-overlay" data-el="portfolio-snapshot-modal">
    <div class="modal modal-sheet snapshot-modal">
      <div class="modal-header">
        <p class="snapshot-hint" data-el="snapshot-hint"></p>
        <label><input type="date" data-el="snapshot-date" /></label>
        <button class="modal-close"></button>
      </div>
      <div class="modal-body">
        <div data-el="snapshot-rows"></div>
        <button data-action="add-position"></button>
      </div>
      <div class="modal-footer">
        <b data-el="snapshot-total"></b>
        <button data-action="cancel"></button>
        <button class="btn-primary" data-el="snapshot-save"
                data-action="save-snapshot">Save snapshot</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" data-el="portfolio-position-modal">
    <div class="modal modal-sm">
      <div class="modal-header"><button class="modal-close"></button></div>
      <div class="modal-body">
        <input data-el="position-name" />
        <select data-el="position-kind">
          <option value="etf">ETF</option>
          <option value="fund">Fund</option>
          <option value="stock">Stock</option>
        </select>
        <input data-el="position-currency" value="EUR" />
        <select data-el="position-depot"></select>
        <div class="is-hidden" data-el="position-depot-new">
          <input data-el="position-depot-name" />
        </div>
      </div>
      <div class="modal-footer">
        <button data-action="cancel"></button>
        <button data-el="position-save" data-action="save-position"></button>
      </div>
    </div>
  </div>
`;

/** A prefill with two depots, one of them holding a position without history. */
function prefill(overrides = {}) {
  return {
    suggested_date: "2020-01-06",
    last_snapshot_date: "2019-12-30",
    snapshot_dates: ["2019-12-23", "2019-12-30"],
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
            previous_value: 1000,
            previous_fx_rate: 1,
            previous_date: "2019-12-30",
            previous_carried: false,
          },
          {
            id: 11,
            name: "FTSE All-World",
            kind: "etf",
            currency: "USD",
            previous_value: 216,
            previous_fx_rate: 1.08,
            previous_date: "2019-12-30",
            previous_carried: false,
          },
        ],
      },
      { id: 2, name: "Deka", positions: [] },
    ],
    ...overrides,
  };
}

const snapshotOverlay = () =>
  document.querySelector('[data-el="portfolio-snapshot-modal"]');
const positionOverlay = () =>
  document.querySelector('[data-el="portfolio-position-modal"]');
const dateInput = () => document.querySelector('[data-el="snapshot-date"]');
const hint = () => document.querySelector('[data-el="snapshot-hint"]');
const saveButton = () => document.querySelector('[data-el="snapshot-save"]');
// The formatters join amount and symbol with a non-breaking space (dom.js).
const EUR = " €";

const totalText = () =>
  document.querySelector('[data-el="snapshot-total"]').textContent;
const rowFor = (id) => document.querySelector(`[data-position-id="${id}"]`);
const fieldOf = (id, field) =>
  rowFor(id).querySelector(`[data-field="${field}"]`);
const deltaOf = (id) => rowFor(id).querySelector(".snapshot-cell-delta");
const staleOf = (id) =>
  rowFor(id).querySelector(".snapshot-cell-name .snapshot-row-stale");

/** Type into a field the way the delegated input listener sees it. */
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Open the form and let the prefill request settle. */
async function openForm(payload = prefill()) {
  global.fetch.mockResolvedValueOnce(jsonResponse(payload));
  openSnapshotModal();
  await flushUi();
}

const lastRequest = () => global.fetch.mock.calls.at(-1);
const lastBody = () => JSON.parse(lastRequest()[1].body);

describe("parseAmountInput", () => {
  it("reads both the German and the English notation", () => {
    const cases = [
      ["1.234,56", 1234.56],
      ["1234,56", 1234.56],
      ["1,234.56", 1234.56],
      ["1234.56", 1234.56],
      ["1.234", 1234],
      ["1,234", 1234],
      ["12.34", 12.34],
      ["12,34", 12.34],
      ["-12,5", -12.5],
      ["1 234,56", 1234.56],
      ["€1.437,38", 1437.38],
      ["$1,234.56", 1234.56],
      ["£1,234.56", 1234.56],
      ["0", 0],
    ];
    for (const [text, expected] of cases) {
      expect(parseAmountInput(text), text).toBe(expected);
    }
  });

  it("reports a blank field as null, not as zero", () => {
    // The API reads null as "carry the previous value forward"; zero would
    // record the position as worthless.
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput("   ")).toBeNull();
    expect(parseAmountInput(null)).toBeNull();
  });

  it("reports an unparseable field as NaN", () => {
    for (const text of ["abc", "1.2.3", "12abc", "-", ","]) {
      expect(parseAmountInput(text), text).toBeNaN();
    }
  });
});

describe("snapshot form", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    global.fetch = vi.fn();
    vi.mocked(loadPortfolio).mockClear();
    vi.mocked(showErrorToast).mockClear();
    vi.mocked(showNoticeToast).mockClear();
    setupSnapshotListeners();
    setupPositionListeners();
  });

  it("renders one labelled group per depot that holds positions", async () => {
    await openForm();

    expect(global.fetch.mock.calls[0][0]).toBe("/api/portfolio/snapshot/new");
    const labels = [...document.querySelectorAll(".snapshot-depot")].map(
      (element) => element.textContent,
    );
    expect(labels).toEqual(["Trade Republic"]);
    expect(document.querySelectorAll(".snapshot-row")).toHaveLength(2);
  });

  it("prefills the suggested date", async () => {
    await openForm();

    expect(dateInput().value).toBe("2020-01-06");
    expect(hint().textContent).toContain("Last snapshot 30.12.2019");
  });

  it("clamps a suggested date that lies in the future", async () => {
    // The prefill suggests the last snapshot plus a week, which the POST would
    // reject as a future date whenever the last one is less than a week old.
    await openForm(prefill({ suggested_date: "2099-01-01" }));

    expect(dateInput().value).toBe(todayIso());
    expect(dateInput().max).toBe(todayIso());
  });

  it("shows an untouched row as carried", async () => {
    await openForm();

    expect(deltaOf(10).textContent).toBe("carried");
    expect(deltaOf(10).classList.contains("is-carried")).toBe(true);
  });

  it("marks a row whose previous reading was itself carried", async () => {
    // The two meanings of "carried" live in different cells: the delta speaks
    // about this save, the name cell about the number it compares against.
    const payload = prefill();
    payload.depots[0].positions[0].previous_carried = true;
    await openForm(payload);

    expect(staleOf(10).textContent.trim()).toBe("· last value carried");
    expect(staleOf(11)).toBeNull();
  });

  it("keeps the carried-previous marker once a real value is typed", async () => {
    const payload = prefill();
    payload.depots[0].positions[0].previous_carried = true;
    await openForm(payload);

    type(fieldOf(10, "value"), "1.100");

    // The row is no longer carrying anything forward, but its delta still
    // measures against a copied reading, so the caveat stays.
    expect(staleOf(10)).not.toBeNull();
    expect(deltaOf(10).textContent).toBe("+100.00");
    expect(deltaOf(10).classList.contains("is-carried")).toBe(false);
  });

  it("subtracts the deposit from the live delta", async () => {
    await openForm();

    type(fieldOf(10, "value"), "1.150");
    type(fieldOf(10, "deposit"), "100");

    // 1150 − 1000 − 100: the deposit is money moved in, not a gain.
    expect(deltaOf(10).textContent).toBe("+50.00");
    expect(deltaOf(10).classList.contains("is-gain")).toBe(true);
  });

  it("marks an unparseable field and blanks its delta", async () => {
    await openForm();

    type(fieldOf(10, "value"), "12,3,4");

    expect(fieldOf(10, "value").classList.contains("is-invalid")).toBe(true);
    expect(deltaOf(10).textContent).toBe("—");
  });

  it("totals the carried and the typed values in EUR", async () => {
    await openForm();

    // 1000 EUR carried + 216 USD at 1.08 = 1200 EUR.
    expect(totalText()).toBe(`1,200.00${EUR}`);

    type(fieldOf(11, "value"), "324");
    expect(totalText()).toBe(`1,300.00${EUR}`);
  });

  it("posts blank fields as null and reloads the view", async () => {
    await openForm();
    type(fieldOf(10, "value"), "1.150");
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    saveButton().click();
    await flushUi();

    expect(lastRequest()[0]).toBe("/api/portfolio/snapshot");
    expect(lastBody()).toEqual({
      date: "2020-01-06",
      rows: [
        { position_id: 10, value: 1150, deposit: null },
        { position_id: 11, value: null, deposit: null },
      ],
    });
    expect(snapshotOverlay().classList.contains("active")).toBe(false);
    expect(loadPortfolio).toHaveBeenCalledTimes(1);
    expect(showNoticeToast).toHaveBeenCalledWith("Snapshot saved");
  });

  it("keeps the form open and reports the server's message on a refusal", async () => {
    await openForm();
    global.fetch.mockResolvedValueOnce(
      jsonResponse(
        { success: false, error: "Position 10 was closed on 2019-12-30" },
        { ok: false, status: 400 },
      ),
    );

    saveButton().click();
    await flushUi();

    expect(showErrorToast).toHaveBeenCalledWith(
      "Position 10 was closed on 2019-12-30",
    );
    expect(snapshotOverlay().classList.contains("active")).toBe(true);
    expect(loadPortfolio).not.toHaveBeenCalled();
  });

  it("announces that a known date is replaced rather than added", async () => {
    await openForm();

    type(dateInput(), "2019-12-30");

    expect(hint().textContent).toBe(
      "A snapshot for 30.12.2019 already exists — saving replaces it.",
    );
    expect(hint().classList.contains("is-warning")).toBe(true);
    expect(saveButton().textContent).toBe("Replace snapshot");

    type(dateInput(), "2020-01-06");
    expect(saveButton().textContent).toBe("Save snapshot");
    expect(hint().classList.contains("is-warning")).toBe(false);
  });

  it("warns about a recorded week older than the newest one", async () => {
    await openForm();

    type(dateInput(), "2019-12-23");

    expect(hint().textContent).toBe(
      "A snapshot for 23.12.2019 already exists — saving replaces it.",
    );
    expect(saveButton().textContent).toBe("Replace snapshot");
  });

  it("refuses a first snapshot with no value to carry forward", async () => {
    await openForm(
      prefill({
        last_snapshot_date: null,
        snapshot_dates: [],
        depots: [
          {
            id: 1,
            name: "Trade Republic",
            positions: [
              {
                id: 12,
                name: "Take-Two",
                kind: "stock",
                currency: "USD",
                previous_value: null,
                previous_fx_rate: null,
                previous_date: null,
                previous_carried: false,
              },
            ],
          },
        ],
      }),
    );

    expect(deltaOf(12).textContent).toBe("—");
    saveButton().click();
    await flushUi();

    expect(showErrorToast).toHaveBeenCalledWith(
      "Take-Two needs a value for its first snapshot",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("hands over to the position dialog when nothing is held yet", async () => {
    await openForm(prefill({ depots: [] }));

    expect(snapshotOverlay().classList.contains("active")).toBe(false);
    expect(positionOverlay().classList.contains("active")).toBe(true);
  });
});

describe("add position", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    global.fetch = vi.fn();
    vi.mocked(loadPortfolio).mockClear();
    vi.mocked(showErrorToast).mockClear();
    setupSnapshotListeners();
    setupPositionListeners();
  });

  /** Open from the empty state and let the depot list settle. */
  async function openPositionForm(payload = prefill()) {
    global.fetch.mockResolvedValueOnce(jsonResponse(payload));
    document
      .querySelector('[data-el="portfolio-empty"] [data-action="add-position"]')
      .click();
    await flushUi();
  }

  const depotSelect = () =>
    document.querySelector('[data-el="position-depot"]');

  it("offers every depot plus a way to create one", async () => {
    await openPositionForm();

    const options = [...depotSelect().options].map((option) => [
      option.value,
      option.textContent,
    ]);
    expect(options).toEqual([
      ["1", "Trade Republic"],
      ["2", "Deka"],
      ["new", "New depot…"],
    ]);
    expect(depotSelect().value).toBe("1");
  });

  it("posts the position and reloads the view", async () => {
    await openPositionForm();
    document.querySelector('[data-el="position-name"]').value = "  Nvidia  ";
    document.querySelector('[data-el="position-kind"]').value = "stock";
    document.querySelector('[data-el="position-currency"]').value = "usd";
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, id: 20 }));

    document.querySelector('[data-el="position-save"]').click();
    await flushUi();

    expect(lastRequest()[0]).toBe("/api/portfolio/positions");
    expect(lastBody()).toEqual({
      depot_id: 1,
      name: "Nvidia",
      kind: "stock",
      currency: "USD",
    });
    expect(positionOverlay().classList.contains("active")).toBe(false);
    expect(loadPortfolio).toHaveBeenCalledTimes(1);
  });

  it("creates the depot first when there is none to pick", async () => {
    // The state a fresh install starts in: no depots, so the select opens on
    // its "New depot…" entry and the name field is revealed.
    await openPositionForm(prefill({ depots: [] }));

    expect(depotSelect().value).toBe("new");
    expect(
      document
        .querySelector('[data-el="position-depot-new"]')
        .classList.contains("is-hidden"),
    ).toBe(false);

    document.querySelector('[data-el="position-name"]').value =
      "MSCI World SRI";
    document.querySelector('[data-el="position-depot-name"]').value =
      "Trade Republic";
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ success: true, id: 7 }))
      .mockResolvedValueOnce(jsonResponse({ success: true, id: 21 }));

    document.querySelector('[data-el="position-save"]').click();
    await flushUi();

    const [depotCall, positionCall] = global.fetch.mock.calls.slice(-2);
    expect(depotCall[0]).toBe("/api/portfolio/depots");
    expect(JSON.parse(depotCall[1].body)).toEqual({ name: "Trade Republic" });
    expect(positionCall[0]).toBe("/api/portfolio/positions");
    expect(JSON.parse(positionCall[1].body).depot_id).toBe(7);
  });

  it("reports a duplicate name instead of adding a second one", async () => {
    await openPositionForm();
    document.querySelector('[data-el="position-name"]').value =
      "MSCI World SRI";
    global.fetch.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error:
            "A position named 'MSCI World SRI' already exists in this depot",
        },
        { ok: false, status: 409 },
      ),
    );

    document.querySelector('[data-el="position-save"]').click();
    await flushUi();

    expect(showErrorToast).toHaveBeenCalledWith(
      "A position named 'MSCI World SRI' already exists in this depot",
    );
    expect(positionOverlay().classList.contains("active")).toBe(true);
  });

  it("refetches the snapshot prefill when opened from the form", async () => {
    // A position added mid-entry has to appear in the form still being filled
    // in, so the prefill is reloaded rather than the view behind it.
    await openForm();
    global.fetch.mockResolvedValueOnce(jsonResponse(prefill()));
    document
      .querySelector(
        '[data-el="portfolio-snapshot-modal"] [data-action="add-position"]',
      )
      .click();
    await flushUi();

    document.querySelector('[data-el="position-name"]').value = "Nvidia";
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ success: true, id: 22 }))
      .mockResolvedValueOnce(jsonResponse(prefill()));

    document.querySelector('[data-el="position-save"]').click();
    await flushUi();

    expect(lastRequest()[0]).toBe("/api/portfolio/snapshot/new");
    expect(loadPortfolio).not.toHaveBeenCalled();
  });
});
