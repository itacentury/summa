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
  resetLabel,
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
        <span class="portfolio-positions-label">Total portfolio</span>
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
    expect(labelText()).toBe("Total portfolio");
  });

  it("lists the all row ahead of the positions, in payload order", () => {
    press(trigger(), "mousedown");

    expect(options().map((row) => row.textContent.trim())).toEqual([
      "Total portfolio",
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
    expect(labelText()).toBe("Total portfolio");
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
    expect(onChange).toHaveBeenNthCalledWith(1, [21], 21);
    expect(onChange).toHaveBeenNthCalledWith(2, POSITIONS_ALL, 21);
  });

  it("reports the all row as a reset, not as a flipped position", () => {
    clickRow(1);
    clickRow(0);

    // Both calls carry POSITIONS_ALL-shaped intent at some point, so the id is
    // the only thing telling "clear everything" from "uncheck this one".
    expect(onChange).toHaveBeenNthCalledWith(2, POSITIONS_ALL, null);
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
      "Total portfolio",
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

  it("counts the picks it has no row for towards the same cap", () => {
    const visible = MANY.slice(0, 3).map((position) => position.id);
    filter.setOptions(MANY);
    filter.setValue(visible, { hidden: PORTFOLIO_MAX_LINES - visible.length });
    press(trigger(), "mousedown");

    // Three rows checked, yet the palette is spent: the other five lines are
    // drawn for picks this payload has no row for.
    const unchecked = options().slice(visible.length + 1);
    expect(
      unchecked.every((row) => row.classList.contains("is-disabled")),
    ).toBe(true);
    expect(
      unchecked.every((row) => row.getAttribute("aria-disabled") === "true"),
    ).toBe(true);
    expect(labelText()).toBe("3 positions");
  });

  it("names the hidden picks in the hint, and only then", () => {
    filter.setOptions(MANY);
    filter.setValue(
      MANY.slice(0, 3).map((position) => position.id),
      {
        hidden: PORTFOLIO_MAX_LINES - 3,
      },
    );
    press(trigger(), "mousedown");

    expect(
      document.querySelector(".portfolio-positions-hint").textContent,
    ).toBe(`Max. ${PORTFOLIO_MAX_LINES} lines · 5 in other depots`);

    // Back to nothing hidden: the unfiltered wording is unchanged.
    filter.setValue(POSITIONS_ALL);
    fill(PORTFOLIO_MAX_LINES);

    expect(
      document.querySelector(".portfolio-positions-hint").textContent,
    ).toBe(`Max. ${PORTFOLIO_MAX_LINES} lines`);
  });

  it("leaves the checked rows and the all row usable under a hidden count", () => {
    filter.setOptions(MANY);
    filter.setValue(
      MANY.slice(0, 3).map((position) => position.id),
      {
        hidden: PORTFOLIO_MAX_LINES - 3,
      },
    );
    press(trigger(), "mousedown");
    const rows = options();

    expect(rows[0].getAttribute("aria-disabled")).toBe("false");
    expect(rows[1].getAttribute("aria-disabled")).toBe("false");
  });

  it("takes a visible pick again once the merged total drops below the cap", () => {
    filter.setOptions(MANY);
    filter.setValue(
      MANY.slice(0, 3).map((position) => position.id),
      {
        hidden: PORTFOLIO_MAX_LINES - 3,
      },
    );
    clickRow(1);
    clickRow(4);

    expect(filter.getValue()).toEqual([MANY[1].id, MANY[2].id, MANY[3].id]);
  });
});

describe("the reset row", () => {
  const resetRow = () => document.querySelector(".portfolio-positions-reset");

  /** The dead end: every pick sits in a depot these rows cannot show. */
  const fullyHidden = () => {
    filter.setValue(POSITIONS_ALL, { hidden: PORTFOLIO_MAX_LINES });
    press(trigger(), "mousedown");
  };

  it("stays away while a row can still be taken", () => {
    press(trigger(), "mousedown");

    expect(resetRow()).toBeNull();
  });

  it("stays away while a checked row can be given back", () => {
    filter.setOptions(MANY);
    for (let index = 1; index <= PORTFOLIO_MAX_LINES; index += 1)
      clickRow(index);

    // The cap bites, but unchecking any of the eight is remedy enough.
    expect(resetRow()).toBeNull();

    filter.setValue([MANY[0].id], { hidden: PORTFOLIO_MAX_LINES - 1 });
    press(trigger(), "mousedown");

    expect(resetRow()).toBeNull();
  });

  it("appears once every row is greyed and none is checked", () => {
    fullyHidden();

    expect(resetRow().textContent).toBe(
      `Clear ${PORTFOLIO_MAX_LINES} picks in other depots`,
    );
    expect(
      options()
        .slice(1)
        .every((row) => row.classList.contains("is-disabled")),
    ).toBe(true);
  });

  it("uses the singular for one hidden pick", () => {
    expect(resetLabel(1)).toBe("Clear 1 pick in other depots");
  });

  it("sits above the hint, which has to stay the last row", () => {
    fullyHidden();

    expect(resetRow().nextElementSibling).toBe(
      document.querySelector(".portfolio-positions-hint"),
    );
  });

  it("reports the clear the way the all row does, so hidden picks go too", () => {
    fullyHidden();
    press(resetRow(), "mousedown");

    expect(onChange).toHaveBeenCalledWith(POSITIONS_ALL, null);
  });

  it("goes once the caller reports the picks cleared", () => {
    fullyHidden();
    press(resetRow(), "mousedown");
    // What the caller answers a cleared selection with.
    filter.setValue(POSITIONS_ALL, { hidden: 0 });

    expect(resetRow()).toBeNull();
    expect(options().some((row) => row.classList.contains("is-disabled"))).toBe(
      false,
    );
  });

  it("is reachable by keyboard, past the last position", () => {
    fullyHidden();
    for (let step = 0; step < POSITIONS.length + 1; step += 1) key("ArrowDown");

    expect(trigger().getAttribute("aria-activedescendant")).toBe(resetRow().id);
    expect(resetRow().classList.contains("is-highlighted")).toBe(true);

    key("Enter");

    expect(onChange).toHaveBeenCalledWith(POSITIONS_ALL, null);
  });

  it("does not let the highlight run past it", () => {
    fullyHidden();
    for (let step = 0; step < POSITIONS.length + 5; step += 1) key("ArrowDown");
    key("Enter");

    // Still the reset, not a row beyond the end that would toggle nothing.
    expect(onChange).toHaveBeenCalledWith(POSITIONS_ALL, null);
  });
});
