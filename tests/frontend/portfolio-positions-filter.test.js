/**
 * The chart's position filter — the control, not the chart.
 *
 * What is worth pinning here is everything that makes it a *multi*-select
 * rather than a copy of the depot dropdown: a toggle leaves the menu open, the
 * leading row clears instead of selecting, and no path can leave the chart with
 * an empty selection to draw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPositionsFilter,
  POSITIONS_ALL,
} from "../../static/js/portfolio-positions-filter.js";
import { PORTFOLIO_MAX_LINES } from "../../static/js/state.js";

// One more position than the chart has colours for, so the cap has something to
// refuse.
const MANY = Array.from({ length: PORTFOLIO_MAX_LINES + 1 }, (_, index) => ({
  id: 100 + index,
  name: `Position ${index}`,
}));

const POSITIONS = [
  { id: 21, name: "Deka Industrie 0" },
  { id: 12, name: "FTSE All-World" },
  { id: 7, name: "Bitcoin" },
];

/** Mount the control's static markup and return its root. */
function mount() {
  document.body.innerHTML = `
    <div class="portfolio-positions" data-el="portfolio-positions">
      <button type="button" class="portfolio-positions-trigger" aria-expanded="false">
        <span class="portfolio-positions-label">All positions</span>
      </button>
      <ul class="portfolio-positions-menu" role="listbox" aria-multiselectable="true"></ul>
    </div>
  `;
  return document.querySelector('[data-el="portfolio-positions"]');
}

const trigger = () => document.querySelector(".portfolio-positions-trigger");
const labelText = () =>
  document.querySelector(".portfolio-positions-label").textContent;
const options = () =>
  Array.from(document.querySelectorAll(".portfolio-positions-option"));
const isOpen = () =>
  document
    .querySelector('[data-el="portfolio-positions"]')
    .classList.contains("is-open");

const press = (element, event) =>
  element.dispatchEvent(new MouseEvent(event, { bubbles: true }));
const key = (name) =>
  trigger().dispatchEvent(new KeyboardEvent("keydown", { key: name }));

/** Open the menu and click the row at `index` (0 is the "all" row). */
const clickRow = (index) => {
  if (!isOpen()) press(trigger(), "mousedown");
  press(options()[index], "mousedown");
};

let onChange;
let filter;

beforeEach(() => {
  onChange = vi.fn();
  filter = createPositionsFilter(mount(), { onChange });
  filter.setOptions(POSITIONS);
});

describe("createPositionsFilter", () => {
  it("starts on every position, which is a cleared selection", () => {
    expect(filter.getValue()).toBe(POSITIONS_ALL);
    expect(labelText()).toBe("All positions");
  });

  it("lists the all row ahead of the positions, in payload order", () => {
    press(trigger(), "mousedown");

    expect(options().map((row) => row.textContent.trim())).toEqual([
      "All positions",
      "Deka Industrie 0",
      "FTSE All-World",
      "Bitcoin",
    ]);
  });

  it("keeps the menu open across a toggle, so a second pick needs no reopen", () => {
    clickRow(1);

    expect(isOpen()).toBe(true);
    clickRow(2);
    expect(filter.getValue()).toEqual([21, 12]);
  });

  it("names the single position it is down to, and counts from two up", () => {
    clickRow(1);
    expect(labelText()).toBe("Deka Industrie 0");

    clickRow(2);
    expect(labelText()).toBe("2 positions");
  });

  it("falls back to every position when the last one is unchecked", () => {
    clickRow(1);
    clickRow(1);

    expect(filter.getValue()).toBe(POSITIONS_ALL);
    expect(labelText()).toBe("All positions");
  });

  it("clears the selection through the all row rather than adding to it", () => {
    clickRow(1);
    clickRow(2);
    clickRow(0);

    expect(filter.getValue()).toBe(POSITIONS_ALL);
  });

  it("reports every change, including the fall back to all", () => {
    clickRow(1);
    clickRow(1);

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, [21]);
    expect(onChange).toHaveBeenNthCalledWith(2, POSITIONS_ALL);
  });

  it("marks the checked rows for the assistive tree, not only for CSS", () => {
    clickRow(2);
    const [all, first, second] = options();

    expect(all.getAttribute("aria-selected")).toBe("false");
    expect(first.getAttribute("aria-selected")).toBe("false");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(second.classList.contains("is-selected")).toBe(true);
  });

  it("toggles from the keyboard without closing, and closes on Escape", () => {
    key("ArrowDown");
    expect(isOpen()).toBe(true);

    key("ArrowDown");
    key(" ");
    expect(filter.getValue()).toEqual([21]);
    expect(isOpen()).toBe(true);

    key("Escape");
    expect(isOpen()).toBe(false);
  });

  it("stops the highlight at both ends rather than wrapping past them", () => {
    key("ArrowDown");
    for (let step = 0; step < 10; step += 1) key("ArrowDown");
    key(" ");

    // The last row, not one past it.
    expect(filter.getValue()).toEqual([7]);
  });

  it("closes on Tab, so the menu cannot outlive the focus that opened it", () => {
    press(trigger(), "mousedown");
    key("Tab");

    expect(isOpen()).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("stays silent while a caller sets the value", () => {
    filter.setValue([12]);

    expect(filter.getValue()).toEqual([12]);
    expect(labelText()).toBe("FTSE All-World");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("escapes a position name rather than trusting it as markup", () => {
    filter.setOptions([{ id: 1, name: "<img src=x>" }]);
    press(trigger(), "mousedown");

    expect(
      document.querySelector(".portfolio-positions-menu").innerHTML,
    ).not.toContain("<img");
  });

  it("places the menu against the viewport, out of the card that clips it", () => {
    press(trigger(), "mousedown");

    expect(
      document.querySelector(".portfolio-positions-menu").style.position,
    ).toBe("fixed");
  });

  it("re-anchors after a toggle, which changes the menu's height", () => {
    const measure = vi.fn(() =>
      trigger().ownerDocument.body.getBoundingClientRect(),
    );
    trigger().getBoundingClientRect = measure;

    press(trigger(), "mousedown");
    const onOpen = measure.mock.calls.length;
    press(options()[1], "mousedown");

    expect(measure.mock.calls.length).toBeGreaterThan(onOpen);
  });

  it("redraws an open menu when the positions are replaced", () => {
    press(trigger(), "mousedown");
    filter.setOptions([{ id: 9, name: "Gold" }]);

    expect(options().map((row) => row.textContent.trim())).toEqual([
      "All positions",
      "Gold",
    ]);
  });
});

describe("the palette cap", () => {
  /** Check the first `count` positions of MANY, in order. */
  const fill = (count) => {
    filter.setOptions(MANY);
    for (let index = 1; index <= count; index += 1) clickRow(index);
  };

  it("stops at one line per palette colour", () => {
    fill(PORTFOLIO_MAX_LINES + 1);

    expect(filter.getValue()).toHaveLength(PORTFOLIO_MAX_LINES);
    expect(onChange).toHaveBeenCalledTimes(PORTFOLIO_MAX_LINES);
  });

  it("greys out what it will not take, and says why", () => {
    fill(PORTFOLIO_MAX_LINES);
    const last = options().at(-1);

    expect(last.getAttribute("aria-disabled")).toBe("true");
    expect(last.classList.contains("is-disabled")).toBe(true);
    expect(
      document.querySelector(".portfolio-positions-hint").textContent,
    ).toContain(String(PORTFOLIO_MAX_LINES));
  });

  it("leaves the checked rows and the all row usable at the cap", () => {
    fill(PORTFOLIO_MAX_LINES);
    const rows = options();

    expect(rows[0].getAttribute("aria-disabled")).toBe("false");
    expect(rows[1].getAttribute("aria-disabled")).toBe("false");
  });

  it("takes a new position again once one is unchecked", () => {
    fill(PORTFOLIO_MAX_LINES);
    clickRow(1);
    clickRow(PORTFOLIO_MAX_LINES + 1);

    expect(filter.getValue()).toHaveLength(PORTFOLIO_MAX_LINES);
    expect(filter.getValue()).toContain(MANY[PORTFOLIO_MAX_LINES].id);
  });

  it("caps a restored selection the same way a live one is capped", () => {
    filter.setOptions(MANY);
    filter.setValue(MANY.map((position) => position.id));

    expect(filter.getValue()).toHaveLength(PORTFOLIO_MAX_LINES);
  });
});
