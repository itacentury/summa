/**
 * Which palette colour each selected chart line draws in. Pure: a position keeps
 * its slot while selected, and a freed slot goes to the next newcomer.
 */

import { PORTFOLIO_MAX_LINES } from "./state.js";
import { chartColors } from "./dom.js";
import { POSITIONS_ALL } from "./portfolio-positions-filter.js";

/**
 * The palette slot per selected position id, carried over where it existed.
 * Newcomers take the lowest free slot; past a full palette they get none, since
 * a repeated colour would claim two holdings are one.
 *
 * @param {Map<number, number>} previous the assignment to carry over
 * @param {string|number[]} selection `POSITIONS_ALL`, or the selected ids
 * @returns {Map<number, number>} position id -> index into `chartColors()`
 */
export function assignLineColors(previous, selection) {
  if (selection === POSITIONS_ALL || !Array.isArray(selection))
    return new Map();

  const next = new Map();
  const taken = new Set();
  const newcomers = [];

  selection.forEach((id) => {
    const slot = previous.get(id);
    if (slot === undefined) {
      newcomers.push(id);
      return;
    }
    next.set(id, slot);
    taken.add(slot);
  });

  let slot = 0;
  newcomers.forEach((id) => {
    while (slot < PORTFOLIO_MAX_LINES && taken.has(slot)) slot += 1;
    if (slot >= PORTFOLIO_MAX_LINES) return;
    next.set(id, slot);
    taken.add(slot);
  });

  return next;
}

/** The colour a position draws in, or `null` while it has no slot. */
export function lineColor(colors, id) {
  const slot = colors.get(id);
  return slot === undefined ? null : chartColors()[slot];
}
