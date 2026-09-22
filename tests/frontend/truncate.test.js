/**
 * Middle-ellipsis truncation.
 *
 * Only the pure half is exercised here: the DOM half depends on canvas text
 * measurement, which happy-dom does not implement, and its absence is itself a
 * documented no-op path. What is worth pinning down is the promise the whole
 * change rests on — that two names sharing a long prefix stay distinguishable
 * after the cut, which end truncation cannot offer.
 */

import { describe, expect, it } from "vitest";

import { middleTruncate } from "../../static/js/truncate.js";

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
