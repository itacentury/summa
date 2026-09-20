/**
 * The Settings → Portfolio section.
 *
 * What is worth pinning down: the two summaries count what the payload actually
 * holds (including depots with nothing in them), and the benchmark select is a
 * single PATCH — setting one position is what unsets the others, so clearing it
 * has to name the position that was flagged before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  refreshPortfolioSettings,
  setupPortfolioSettings,
} from "../../static/js/settings-portfolio.js";
import { openManageModal } from "../../static/js/portfolio-manage.js";
import { loadPortfolio } from "../../static/js/portfolio.js";
import { showErrorToast } from "../../static/js/toast.js";
import { flushUi, jsonResponse } from "./helpers.js";

vi.mock("../../static/js/portfolio.js", () => ({
  loadPortfolio: vi.fn(async () => {}),
}));
vi.mock("../../static/js/portfolio-manage.js", () => ({
  openManageModal: vi.fn(),
}));
vi.mock("../../static/js/toast.js", () => ({
  showErrorToast: vi.fn(),
  showNoticeToast: vi.fn(),
}));

const markup = `
  <div class="settings-row">
    <span class="settings-row-sub" data-el="settings-depots-sub"></span>
    <button data-action="manage-depots"></button>
  </div>
  <div class="settings-row">
    <span class="settings-row-sub" data-el="settings-positions-sub"></span>
    <button data-action="manage-positions"></button>
  </div>
  <select data-el="settings-benchmark"></select>
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
            closed_at: null,
            is_benchmark_fallback: true,
          },
          {
            id: 11,
            name: "AMD",
            closed_at: "2026-03-01",
            is_benchmark_fallback: false,
          },
        ],
      },
      { id: 2, name: "Deka", positions: [] },
    ],
  };
}

function sub(name) {
  return document.querySelector(`[data-el="settings-${name}-sub"]`).textContent;
}

function select() {
  return document.querySelector('[data-el="settings-benchmark"]');
}

describe("settings → portfolio", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => jsonResponse(payload()));
  });

  it("summarises the depots, including the empty ones", async () => {
    await refreshPortfolioSettings();

    expect(sub("depots")).toBe("Trade Republic · Deka");
  });

  it("counts active and closed positions apart", async () => {
    await refreshPortfolioSettings();

    expect(sub("positions")).toBe(
      "1 active · 1 closed · type, currency, depot",
    );
  });

  it("says so when there is no depot at all", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ depots: [] }));

    await refreshPortfolioSettings();

    expect(sub("depots")).toBe("None yet");
    expect(sub("positions")).toBe(
      "0 active · 0 closed · type, currency, depot",
    );
  });

  it("offers the active positions only, preselecting the flagged one", async () => {
    await refreshPortfolioSettings();

    const options = [...select().options].map((option) => option.textContent);
    expect(options).toEqual(["None", "MSCI World SRI"]);
    expect(select().value).toBe("10");
  });

  it("escapes a position name", async () => {
    const data = payload();
    data.depots[0].positions[0].name = "<img src=x>";
    global.fetch = vi.fn(async () => jsonResponse(data));

    await refreshPortfolioSettings();

    expect(select().innerHTML).toContain("&lt;img src=x&gt;");
    expect(select().querySelector("img")).toBeNull();
  });

  it("flags the position that was picked", async () => {
    setupPortfolioSettings();
    await refreshPortfolioSettings();
    const data = payload();
    data.depots[0].positions.push({
      id: 12,
      name: "Core Stoxx Europe 600",
      closed_at: null,
      is_benchmark_fallback: false,
    });
    global.fetch = vi.fn(async () => jsonResponse(data));
    await refreshPortfolioSettings();

    select().value = "12";
    select().dispatchEvent(new Event("change"));
    await flushUi();

    const [url, options] = global.fetch.mock.calls.at(-1);
    expect(url).toBe("/api/portfolio/positions/12");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({ is_benchmark_fallback: true });
    expect(loadPortfolio).toHaveBeenCalled();
  });

  it("unflags the previous position when the choice is cleared", async () => {
    setupPortfolioSettings();
    await refreshPortfolioSettings();

    select().value = "";
    select().dispatchEvent(new Event("change"));
    await flushUi();

    const [url, options] = global.fetch.mock.calls.at(-1);
    expect(url).toBe("/api/portfolio/positions/10");
    expect(JSON.parse(options.body)).toEqual({ is_benchmark_fallback: false });
  });

  it("restores the select when the server refuses", async () => {
    setupPortfolioSettings();
    await refreshPortfolioSettings();
    global.fetch = vi.fn(async () =>
      jsonResponse({ error: "Position not found" }, { ok: false, status: 404 }),
    );

    select().value = "";
    select().dispatchEvent(new Event("change"));
    await flushUi();

    expect(showErrorToast).toHaveBeenCalledWith("Position not found");
    expect(select().value).toBe("10");
  });

  it("opens each editor in its own mode", async () => {
    setupPortfolioSettings();

    document.querySelector('[data-action="manage-depots"]').click();
    document.querySelector('[data-action="manage-positions"]').click();

    expect(openManageModal.mock.calls[0][0]).toBe("depots");
    expect(openManageModal.mock.calls[1][0]).toBe("positions");
  });

  it("leaves the rows blank when the payload cannot be loaded", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({}, { ok: false, status: 500 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(refreshPortfolioSettings()).resolves.toBeUndefined();
    expect(sub("depots")).toBe("");
  });
});
