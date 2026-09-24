/**
 * The chart card's position filter: a multi-select listbox. A click toggles, the
 * menu stays open, and the leading "all" row clears; nothing reaches the server.
 */

import { escapeHtml } from "./dom.js";
import { PORTFOLIO_MAX_LINES } from "./state.js";
import { createFloatingMenu } from "./floating-menu.js";
import { setTruncatableText } from "./truncate.js";
import { bindListboxTrigger } from "./listbox.js";

export const POSITIONS_ALL = "all";
const ALL_LABEL = "Total portfolio";

const ALL_INDEX = 0;

/**
 * Shown once the palette is spent. Off-screen picks are named because they make
 * the ceiling bite while fewer than `PORTFOLIO_MAX_LINES` rows are checked.
 */
const limitHint = (hidden) =>
  hidden === 0
    ? `Max. ${PORTFOLIO_MAX_LINES} lines`
    : `Max. ${PORTFOLIO_MAX_LINES} lines · ${hidden} in other depots`;

export const resetLabel = (hidden) =>
  `Clear ${hidden} pick${hidden === 1 ? "" : "s"} in other depots`;

/**
 * Create the position filter bound to `root`. `onChange(value, toggled)` fires
 * only on a user toggle; `value` is `POSITIONS_ALL` or an id array, `toggled`
 * the flipped id or `null` for the "all" row — both read `POSITIONS_ALL`, and
 * only the caller, which may hold a wider selection, can tell them apart.
 *
 * `setValue()`'s `hidden` count covers that wider selection: its picks spend
 * palette slots too, so they count towards the ceiling.
 */
export function createPositionsFilter(root, { onChange } = {}) {
  const trigger = root.querySelector(".portfolio-positions-trigger");
  const label = root.querySelector(".portfolio-positions-label");
  const menu = root.querySelector(".portfolio-positions-menu");

  menu.id = "portfolio-positions-menu";
  trigger.setAttribute("aria-controls", menu.id);

  // Placed against the viewport because the chart card clips; that loses the
  // depot menu's free `min-width: 100%`, hence matchTrigger.
  const floating = createFloatingMenu(trigger, menu, {
    minWidth: 190,
    matchTrigger: true,
  });

  // An empty set *is* "all", so unchecking the last row cannot leave nothing to draw.
  let positions = [];
  let selected = new Set();
  let highlighted = ALL_INDEX;
  let open = false;

  // The caller's picks this payload has no row for; never part of `value()`.
  let hiddenCount = 0;

  const value = () => (selected.size === 0 ? POSITIONS_ALL : [...selected]);

  // One palette color per line; hidden picks hold colors too, so they count.
  const atLimit = () => selected.size + hiddenCount >= PORTFOLIO_MAX_LINES;

  // Hidden picks alone spent the palette: every row is greyed out and the
  // checked "all" row reads as the state in force, not as the way out.
  const resetShown = () => selected.size === 0 && atLimit();

  // After the last position, so keyboard and clicks share one index scheme.
  const resetIndex = () => (resetShown() ? positions.length + 1 : -1);

  // Unlike atLimit(), counts only visible rows: the chart draws no hidden line.
  const applyLabel = () => {
    if (selected.size === 0) {
      setTruncatableText(label, ALL_LABEL);
      return;
    }
    if (selected.size === 1) {
      const [id] = selected;
      const position = positions.find((entry) => entry.id === id);
      setTruncatableText(label, position ? position.name : "1 position");
      return;
    }
    setTruncatableText(label, `${selected.size} positions`);
  };

  /** Index 0 is the "all" row, the rest are positions. */
  const positionAt = (index) => positions[index - 1];

  const rowHtml = (index, isSelected, name) => {
    // The "all" row clears rather than adds, so the ceiling never applies to it.
    const isDisabled = !isSelected && index !== ALL_INDEX && atLimit();
    return `
    <li class="portfolio-positions-option${isSelected ? " is-selected" : ""}${
      index === highlighted ? " is-highlighted" : ""
    }${isDisabled ? " is-disabled" : ""}"
        role="option" aria-selected="${isSelected}" aria-disabled="${isDisabled}"
        id="${menu.id}-option-${index}" data-index="${index}">
      <span class="portfolio-positions-check" aria-hidden="true"></span>
      <span class="portfolio-positions-option-label">${escapeHtml(name)}</span>
    </li>
  `;
  };

  // One line, so its text node is exactly the label.
  const resetHtml = () => {
    const index = resetIndex();
    const highlight = index === highlighted ? " is-highlighted" : "";
    return `<li class="portfolio-positions-reset${highlight}" role="option" aria-selected="false" id="${menu.id}-option-${index}" data-index="${index}">${resetLabel(hiddenCount)}</li>`;
  };

  const renderMenu = () => {
    // role="presentation": the hint labels the list, it is not an option.
    const hint = atLimit()
      ? `<li class="portfolio-positions-hint" role="presentation">${limitHint(hiddenCount)}</li>`
      : "";
    menu.innerHTML = [
      rowHtml(ALL_INDEX, selected.size === 0, ALL_LABEL),
      ...positions.map((position, index) =>
        rowHtml(index + 1, selected.has(position.id), position.name),
      ),
      // Above the hint, which is sticky and must stay last.
      resetShown() ? resetHtml() : "",
      hint,
    ].join("");

    const active = menu.querySelector(`#${menu.id}-option-${highlighted}`);
    if (active) trigger.setAttribute("aria-activedescendant", active.id);
    else trigger.removeAttribute("aria-activedescendant");
  };

  const closeMenu = () => {
    if (!open) return;
    open = false;
    floating.release();
    root.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
  };

  const openMenu = () => {
    if (open) return;
    open = true;
    root.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    highlighted = ALL_INDEX;
    renderMenu();
    // After renderMenu, so the new rows are what gets measured.
    floating.place();
    floating.bind();
  };

  /**
   * Flip one row. The "all" and reset rows clear the selection; a pick past the
   * palette ceiling (hidden picks included) is a silent no-op, as its greyed-out
   * row promised, so no off-screen line is ever evicted.
   */
  const toggle = (index) => {
    let toggled = null;
    // Read before clearing: the reset index derives from the state being cleared.
    const isReset = index === resetIndex();
    if (index === ALL_INDEX || isReset) {
      selected = new Set();
      // The reset row is about to disappear, so the highlight must leave it.
      if (isReset) highlighted = ALL_INDEX;
    } else {
      const position = positionAt(index);
      if (!position) return;
      if (selected.has(position.id)) selected.delete(position.id);
      else if (atLimit()) return;
      else selected.add(position.id);
      toggled = position.id;
    }
    applyLabel();
    renderMenu();
    // The row count changed the height; re-place so the panel stays on its trigger.
    floating.place();
    if (onChange) onChange(value(), toggled);
  };

  // Also needed by setOptions(): replacing the rows can strand the index.
  const clampHighlight = () => {
    const last = positions.length + (resetShown() ? 1 : 0);
    highlighted = Math.max(ALL_INDEX, Math.min(last, highlighted));
  };

  const moveHighlight = (delta) => {
    highlighted += delta;
    clampHighlight();
    renderMenu();
  };

  bindListboxTrigger({
    root,
    trigger,
    menu,
    optionSelector: ".portfolio-positions-option, .portfolio-positions-reset",
    isOpen: () => open,
    open: openMenu,
    close: closeMenu,
    move: moveHighlight,
    // The menu stays open: picking another position is the normal next step.
    activate: () => toggle(highlighted),
    pick: (index) => {
      highlighted = index;
      toggle(index);
    },
  });

  applyLabel();

  return {
    /** Replace the selectable positions; pruning the selection is the caller's job. */
    setOptions(entries) {
      positions = entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
      }));
      clampHighlight();
      applyLabel();
      if (!open) return;
      renderMenu();
      floating.place();
    },
    /** Check `next`; `hidden` off-screen picks count towards the ceiling. */
    setValue(next, { hidden = 0 } = {}) {
      hiddenCount = hidden;
      // Capped so a restored selection cannot seat more lines than a live one;
      // the hidden picks are served first.
      selected =
        next === POSITIONS_ALL
          ? new Set()
          : new Set(
              [...next].slice(0, Math.max(0, PORTFOLIO_MAX_LINES - hidden)),
            );
      applyLabel();
      // The reset row depends on `hidden`, so a recount can strand the highlight.
      clampHighlight();
      if (open) renderMenu();
    },
    getValue() {
      return value();
    },
  };
}
