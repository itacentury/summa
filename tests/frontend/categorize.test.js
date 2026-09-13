/**
 * Frontend unit tests for the AI-categorize trigger badge and the run's scope
 * messaging. The badge must count only the uncategorized invoices on the current
 * page (`state.invoices`), so it matches exactly what the AI action analyzes,
 * while `state.uncategorizedCount` (the whole filtered set) is what lets the
 * dialog name how many the other pages still hold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { state } from "../../static/js/state.js";
import {
  runAnalysis,
  updateAiTriggerBadge,
} from "../../static/js/categorize.js";

function mountTriggerFixture() {
  document.body.innerHTML = `
    <button data-el="ai-categories-trigger">
      <span data-el="ai-categories-badge"></span>
    </button>
  `;
}

// runAnalysis writes the subtitle, the content and the footer, so the modal shell
// those selectors live in must be present — including the footer's own fields,
// which a rendered review fills in.
function mountModalFixture() {
  document.body.innerHTML = `
    <div data-el="categorize-modal" class="active">
      <p data-el="categorize-subtitle"></p>
      <div data-el="categorize-content"></div>
      <div data-el="categorize-footer">
        <span data-el="categorize-summary-text"></span>
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
  const fetchMock = vi.fn((url) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(jsonFor(url)),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** One suggestion row, shaped like the endpoint's. */
function suggestion(id) {
  return {
    invoice_id: id,
    store: "MediaMarkt",
    total: 42.5,
    items: [{ item_name: "Cable", item_price: 42.5 }],
    category: "Electronics",
    is_new: false,
  };
}

function noteText() {
  return document.querySelector(".categorize-note")?.textContent ?? "";
}

function button() {
  return document.querySelector('[data-el="ai-categories-trigger"]');
}

function badge() {
  return document.querySelector('[data-el="ai-categories-badge"]');
}

describe("updateAiTriggerBadge", () => {
  beforeEach(() => {
    mountTriggerFixture();
    state.invoices = [];
    state.uncategorizedCount = 0;
  });

  it("counts only the uncategorized invoices on the current page", () => {
    state.invoices = [
      { id: 1, category: null },
      { id: 2, category: "Groceries" },
      { id: 3, category: null },
    ];
    state.uncategorizedCount = 5;

    updateAiTriggerBadge();

    expect(badge().textContent).toBe("2");
    expect(button().classList.contains("is-empty")).toBe(false);
    expect(button().title).toBe("AI Categories");
    expect(button().getAttribute("aria-label")).toBe("AI Categories");
  });

  it("damps but keeps the trigger clickable when the page has none", () => {
    // Never disabled: a disabled button could not open the dialog, and the
    // dialog's empty state is the only place the page-scoping is explained.
    state.invoices = [{ id: 1, category: "Groceries" }];
    state.uncategorizedCount = 3;

    updateAiTriggerBadge();

    expect(badge().textContent).toBe("0");
    expect(button().disabled).toBe(false);
    expect(button().classList.contains("is-empty")).toBe(true);
    expect(button().title).toContain("3 on other pages in this period");
    // aria-label wins the accessible name, so it must carry the hint too — while
    // still naming the control, which a verbatim copy of the tooltip would not.
    const label = button().getAttribute("aria-label");
    expect(label).toContain("AI Categories");
    expect(label).toContain("3 on other pages in this period");
  });

  it("claims nothing about other pages when the filter holds none", () => {
    state.invoices = [{ id: 1, category: "Groceries" }];
    state.uncategorizedCount = 0;

    updateAiTriggerBadge();

    expect(button().title).toBe(
      "AI Categories — nothing uncategorized in this period",
    );
  });
});

describe("runAnalysis", () => {
  beforeEach(() => {
    mountModalFixture();
    state.invoices = [];
    state.uncategorizedCount = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts only the ids of the uncategorized invoices on the current page", async () => {
    state.invoices = [
      { id: 1, category: null },
      { id: 2, category: "Groceries" },
      { id: 3, category: null },
    ];

    const fetchMock = stubSuggest({ suggestions: [], total: 0, count: 0 });

    await runAnalysis();

    const suggestCall = fetchMock.mock.calls.find(([url]) =>
      url.startsWith("/api/invoices/categorize-suggest"),
    );
    expect(JSON.parse(suggestCall[1].body).ids).toEqual([1, 3]);
  });

  it("names the other pages' uncategorized invoices on a clean page", async () => {
    // The reachable path for the empty banner: the trigger stays clickable on a
    // clean page, so opening it must land on the explanation, not a blank body.
    state.invoices = [{ id: 1, category: "Groceries" }];
    state.uncategorizedCount = 4;

    const fetchMock = stubSuggest({ suggestions: [], total: 0, count: 0 });

    await runAnalysis();

    const content = document.querySelector('[data-el="categorize-content"]');
    expect(content.textContent).toContain("4 on other pages in this period");
    expect(document.querySelector('[data-el="categorize-footer"]').hidden).toBe(
      true,
    );
    // The outcome is knowable without the network: no suggest POST, no category GET.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-el="categorize-subtitle"]').textContent,
    ).toBe("0 uncategorized invoices on this page");
  });

  it("claims no other pages when the whole filter is categorized", async () => {
    state.invoices = [{ id: 1, category: "Groceries" }];
    state.uncategorizedCount = 0;

    await runAnalysis();

    expect(
      document.querySelector('[data-el="categorize-content"]').textContent,
    ).toBe("No uncategorized invoices in this period.");
  });

  it("notes the uncategorized invoices this run's page does not cover", async () => {
    state.invoices = [{ id: 1, category: null }];
    // One on this page, three in the filter — two of them on other pages.
    state.uncategorizedCount = 3;
    stubSuggest({ suggestions: [suggestion(1)], total: 1, count: 1 });

    await runAnalysis();

    expect(noteText()).toContain(
      "2 more uncategorized invoices on other pages in this period.",
    );
    // Not a capped run, so only the cross-page sentence is in the band.
    expect(noteText()).not.toContain("First");
  });

  it("drops the note when the page covers every uncategorized invoice", async () => {
    state.invoices = [{ id: 1, category: null }];
    state.uncategorizedCount = 1;
    stubSuggest({ suggestions: [suggestion(1)], total: 1, count: 1 });

    await runAnalysis();

    expect(document.querySelector(".categorize-note")).toBeNull();
  });
});
