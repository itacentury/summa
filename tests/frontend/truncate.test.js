/**
 * Middle-ellipsis truncation.
 *
 * The promise the whole change rests on — that two names sharing a long prefix
 * stay distinguishable after the cut, which end truncation cannot offer — plus
 * the shape of the DOM half, which happy-dom can only show once canvas text
 * measurement and element widths are stubbed.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  applyTruncation,
  middleTruncate,
  refreshTruncation,
} from "../../static/js/truncate.js";

// A proportional font is not needed to prove the rule; one unit per character
// keeps every expectation below countable by hand.
const perCharacter = (text) => text.length;

describe("middleTruncate", () => {
  it("returns a string that already fits untouched", () => {
    expect(middleTruncate("MSCI World", 20, perCharacter)).toBe("MSCI World");
  });

  it("never returns more than the available width", () => {
    const name = "iShares Core MSCI World UCITS ETF USD (Acc)";
    for (const width of [4, 7, 12, 20, 31]) {
      expect(
        perCharacter(middleTruncate(name, width, perCharacter)),
      ).toBeLessThanOrEqual(width);
    }
  });

  it("keeps both ends, so a shared prefix no longer hides the difference", () => {
    const accumulating = "iShares Core MSCI World UCITS ETF USD (Acc)";
    const distributing = "iShares Core MSCI World UCITS ETF USD (Dist)";

    const left = middleTruncate(accumulating, 24, perCharacter);
    const right = middleTruncate(distributing, 24, perCharacter);

    expect(left).toContain("iShares");
    expect(left).toContain("(Acc)");
    expect(right).toContain("(Dist)");
    expect(left).not.toBe(right);
  });

  it("uses every character the width allows, splitting the room evenly", () => {
    expect(middleTruncate("abcdefghij", 5, perCharacter)).toBe("ab…ij");
    // An odd allowance gives the extra character to the head, which is what a
    // reader scans a list by.
    expect(middleTruncate("abcdefghij", 4, perCharacter)).toBe("ab…j");
  });

  it("degrades to a bare ellipsis when nothing else fits", () => {
    expect(middleTruncate("abcdefghij", 1, perCharacter)).toBe("…");
  });
});

/**
 * The DOM half, with canvas measurement and element widths stubbed.
 *
 * What is worth pinning down here is not the cut itself but its *shape*: reads
 * and writes must stay in separate passes over the whole set, because a read
 * that follows a write forces a layout, and one per name is what made a
 * drag-resize linear in the number of positions.
 */

// One unit per character again, through the interface the module reaches for.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => ({
    font: "",
    measureText: (text) => ({ width: text.length }),
  });
});

const NAME = "iShares Core MSCI World UCITS ETF USD (Acc)";

/**
 * A host/carrier pair whose width is fixed and whose reads and writes are
 * recorded into the shared `log`, in the order the module performs them.
 */
function makeCarrier(log, width) {
  const host = document.createElement("span");
  const carrier = document.createElement("span");
  carrier.dataset.full = NAME;
  carrier.textContent = NAME;
  host.append(carrier);

  Object.defineProperty(host, "clientWidth", {
    get() {
      log.push("read");
      return width;
    },
  });

  const text = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "textContent",
  );
  Object.defineProperty(carrier, "textContent", {
    get() {
      return text.get.call(this);
    },
    set(value) {
      log.push("write");
      text.set.call(this, value);
    },
  });

  return { host, carrier };
}

/** The log with runs collapsed, e.g. W W R R W → ["write", "read", "write"]. */
function phases(log) {
  return log.filter((entry, index) => entry !== log[index - 1]);
}

/** A detached root holding `count` carriers, all of them too narrow for the name. */
function makeRoot(log, count, width) {
  const root = document.createElement("div");
  for (let index = 0; index < count; index += 1) {
    root.append(makeCarrier(log, width).host);
  }
  return root;
}

describe("recut phases", () => {
  it("costs the same number of layout passes however many names there are", () => {
    const few = [];
    const many = [];

    refreshTruncation(makeRoot(few, 5, 10));
    refreshTruncation(makeRoot(many, 20, 10));

    // Reads and writes alternate in blocks, never per name: write the full
    // names, read every width, write every cut, read every width again.
    expect(phases(few)).toEqual(["write", "read", "write", "read"]);
    expect(phases(many)).toEqual(phases(few));
    expect(many.length).toBeGreaterThan(few.length);
  });
});

describe("applyTruncation", () => {
  it("cuts the name and keeps the full one in the accessibility tree", () => {
    const { host, carrier } = makeCarrier([], 10);

    applyTruncation(carrier);

    expect(carrier.textContent).not.toBe(NAME);
    expect(carrier.textContent).toContain("…");
    expect(carrier.getAttribute("aria-hidden")).toBe("true");
    expect(carrier.getAttribute("title")).toBe(NAME);
    expect(host.querySelector('[data-el="spoken-name"]').textContent).toBe(
      NAME,
    );
  });

  it("leaves a name that fits alone", () => {
    const { host, carrier } = makeCarrier([], 200);

    applyTruncation(carrier);

    expect(carrier.textContent).toBe(NAME);
    expect(carrier.hasAttribute("aria-hidden")).toBe(false);
    expect(carrier.hasAttribute("title")).toBe(false);
    expect(host.querySelector('[data-el="spoken-name"]')).toBe(null);
  });

  it("does not ratchet the name shorter on a re-run", () => {
    const { carrier } = makeCarrier([], 10);

    applyTruncation(carrier);
    const once = carrier.textContent;
    applyTruncation(carrier);

    expect(carrier.textContent).toBe(once);
  });

  it("restores the full name once the host is wide enough again", () => {
    const log = [];
    let width = 10;
    const host = document.createElement("span");
    const carrier = document.createElement("span");
    carrier.dataset.full = NAME;
    host.append(carrier);
    Object.defineProperty(host, "clientWidth", {
      get() {
        log.push("read");
        return width;
      },
    });

    applyTruncation(carrier);
    expect(carrier.textContent).not.toBe(NAME);

    width = 200;
    applyTruncation(carrier);

    expect(carrier.textContent).toBe(NAME);
    expect(carrier.hasAttribute("aria-hidden")).toBe(false);
    expect(host.querySelector('[data-el="spoken-name"]')).toBe(null);
  });
});

/**
 * The font binding.
 *
 * `context.font = …` ignores what it cannot parse instead of throwing, so a
 * rejected assignment leaves the previous font bound — which would make one bad
 * font mismeasure every later carrier rather than fall back. These cases use a
 * context whose setter behaves like the real parser; the stub above accepts
 * every string, which is why the cases here need their own.
 */

/** A context that only accepts `<…> <size>px <family>` and records what it measured with. */
function makeStrictContext() {
  let current = "10px sans-serif";
  const used = [];
  return {
    used,
    get font() {
      return current;
    },
    set font(value) {
      if (/\d+px\s+\S/.test(value)) current = value;
    },
    measureText(text) {
      used.push(current);
      return { width: text.length };
    },
  };
}

/** A computed style whose `font` and longhands are whatever the browser is pretending to report. */
function stubComputedStyle(styleFor) {
  window.getComputedStyle = (element) => ({
    fontStyle: "normal",
    fontWeight: "400",
    fontSize: "16px",
    fontFamily: "sans-serif",
    ...styleFor(element),
  });
}

describe("font binding", () => {
  let previousGetContext;
  let previousGetComputedStyle;
  let context;

  beforeEach(() => {
    previousGetContext = HTMLCanvasElement.prototype.getContext;
    previousGetComputedStyle = window.getComputedStyle;
    context = makeStrictContext();
    HTMLCanvasElement.prototype.getContext = () => context;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = previousGetContext;
    window.getComputedStyle = previousGetComputedStyle;
  });

  /** The module caches its context for its whole lifetime, so each case needs a fresh instance. */
  async function freshModule() {
    vi.resetModules();
    return import("../../static/js/truncate.js");
  }

  it("leaves the name uncut when the font cannot be bound", async () => {
    stubComputedStyle(() => ({ font: "nonsense" }));
    const { applyTruncation } = await freshModule();
    const { host, carrier } = makeCarrier([], 10);

    applyTruncation(carrier);

    expect(carrier.textContent).toBe(NAME);
    expect(carrier.hasAttribute("aria-hidden")).toBe(false);
    expect(carrier.hasAttribute("title")).toBe(false);
    expect(host.querySelector('[data-el="spoken-name"]')).toBe(null);
  });

  it("does not let a rejected font leak into the next carrier", async () => {
    const good = '500 12px "Sora"';
    stubComputedStyle((element) => ({
      font: element.dataset.font === "bad" ? "nonsense" : good,
    }));
    const { refreshTruncation } = await freshModule();

    const root = document.createElement("div");
    const bad = makeCarrier([], 10);
    bad.carrier.dataset.font = "bad";
    const fine = makeCarrier([], 10);
    root.append(bad.host, fine.host);

    refreshTruncation(root);

    expect(bad.carrier.textContent).toBe(NAME);
    expect(fine.carrier.textContent).toContain("…");
    // Nothing was measured with the canvas default or with a neighbour's font.
    expect(new Set(context.used)).toEqual(new Set([good]));
  });

  it("composes the shorthand from the longhands when the browser reports none", async () => {
    stubComputedStyle(() => ({
      font: "",
      fontStyle: "italic",
      fontWeight: "600",
      fontSize: "12px",
      fontFamily: '"Sora", sans-serif',
    }));
    const { applyTruncation } = await freshModule();
    const { carrier } = makeCarrier([], 10);

    applyTruncation(carrier);

    expect(carrier.textContent).toContain("…");
    expect(context.used[0]).toBe('italic 600 12px "Sora", sans-serif');
  });
});
