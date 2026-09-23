/**
 * The palette-slot assignment behind the chart's position lines.
 *
 * What is worth pinning here are the two rules the chart depends on and cannot
 * check for itself: a selected position keeps its slot across every other
 * toggle, and no two selected positions ever share one.
 */

import { describe, expect, it } from "vitest";

import { assignLineColors } from "../../static/js/portfolio-line-colors.js";
import { POSITIONS_ALL } from "../../static/js/portfolio-positions-filter.js";
import { PORTFOLIO_MAX_LINES } from "../../static/js/state.js";

describe("assignLineColors", () => {
  it("hands out slots in selection order", () => {
    const colors = assignLineColors(new Map(), [21, 12, 7]);

    expect([...colors]).toEqual([
      [21, 0],
      [12, 1],
      [7, 2],
    ]);
  });

  it("leaves the remaining lines on their slot when one is unchecked", () => {
    const before = assignLineColors(new Map(), [21, 12, 7]);

    const after = assignLineColors(before, [21, 7]);

    expect(after.get(21)).toBe(0);
    expect(after.get(7)).toBe(2);
    expect(after.has(12)).toBe(false);
  });

  it("gives the freed slot to the next newcomer", () => {
    const before = assignLineColors(new Map(), [21, 12, 7]);
    const freed = assignLineColors(before, [21, 7]);

    const after = assignLineColors(freed, [21, 7, 99]);

    expect(after.get(99)).toBe(1);
  });

  it("keeps a slot across a re-selection in a different order", () => {
    const before = assignLineColors(new Map(), [21, 12]);

    const after = assignLineColors(before, [12, 21]);

    expect(after.get(21)).toBe(0);
    expect(after.get(12)).toBe(1);
  });

  it("assigns nothing while every position is shown", () => {
    const before = assignLineColors(new Map(), [21, 12]);

    expect(assignLineColors(before, POSITIONS_ALL).size).toBe(0);
  });

  it("gives no slot at all rather than repeating one past the palette", () => {
    const ids = Array.from(
      { length: PORTFOLIO_MAX_LINES + 2 },
      (_, i) => i + 1,
    );

    const colors = assignLineColors(new Map(), ids);
    const slots = [...colors.values()];

    expect(colors.size).toBe(PORTFOLIO_MAX_LINES);
    expect(new Set(slots).size).toBe(PORTFOLIO_MAX_LINES);
  });
});
