/**
 * The chart card's position filter: a multi-select listbox.
 *
 * Structurally the depot filter's twin (`portfolio-depot.js`) — read its
 * comments for why each interaction rule exists — with the three differences a
 * multi-select needs: a click toggles rather than commits, the menu stays open
 * across toggles, and a leading "all" row clears the selection instead of being
 * one more value.
 *
 * Unlike the depot filter, nothing here reaches the server: the payload already
 * carries a line per position, so a toggle only redraws.
 */

import { escapeHtml } from "./dom.js";
import { PORTFOLIO_MAX_LINES } from "./state.js";
import { createFloatingMenu } from "./floating-menu.js";

// The value the filter carries while nothing is picked out. Kept here so the
// markup, the storage and the chart agree on one token.
export const POSITIONS_ALL = "all";
const ALL_LABEL = "Total portfolio";

// Index of the leading "all" row, which is not one of the positions.
const ALL_INDEX = 0;

// Shown under the rows once the palette is spent, so the greyed-out rows say
// why rather than just failing to respond.
const LIMIT_HINT = `Max. ${PORTFOLIO_MAX_LINES} lines`;

/**
 * Create the position filter bound to `root` (the `.portfolio-positions`
 * element). `onChange(value, toggled)` fires only on a user-driven toggle,
 * never on setValue() or setOptions(); `value` is either `POSITIONS_ALL` or an
 * array of position ids, and `toggled` is the id of the flipped row, or `null`
 * for the "all" row.
 *
 * The second argument exists because `value` alone collapses two different
 * intents: clearing via the "all" row and unchecking the last position both
 * read `POSITIONS_ALL`. The caller owns the selection — which may be wider than
 * the rows shown here — so only it can decide what either one means for the
 * part it is not showing.
 */
export function createPositionsFilter(root, { onChange } = {}) {
  const trigger = root.querySelector(".portfolio-positions-trigger");
  const label = root.querySelector(".portfolio-positions-label");
  const menu = root.querySelector(".portfolio-positions-menu");

  menu.id = "portfolio-positions-menu";
  trigger.setAttribute("aria-controls", menu.id);

  // The chart card clips its content, so the menu has to be placed against the
  // viewport rather than against the card it lives in. That costs it the
  // `min-width: 100%` the depot menu gets for free, and the trigger is stretched
  // to the full row on narrow screens — hence matchTrigger.
  const floating = createFloatingMenu(trigger, menu, {
    minWidth: 190,
    matchTrigger: true,
  });

  // The selectable positions in render order, and the ids picked out of them.
  // An empty set *is* "all": the two are never distinct states, so unchecking
  // the last row cannot leave the chart with nothing to draw.
  let positions = [];
  let selected = new Set();
  let highlighted = ALL_INDEX;
  let open = false;

  const value = () => (selected.size === 0 ? POSITIONS_ALL : [...selected]);

  // The chart draws one palette color per line, so the palette is the ceiling:
  // a further line could only repeat a color another holding already owns.
  const atLimit = () => selected.size >= PORTFOLIO_MAX_LINES;

  const applyLabel = () => {
    if (selected.size === 0) {
      label.textContent = ALL_LABEL;
      return;
    }
    if (selected.size === 1) {
      const [id] = selected;
      const position = positions.find((entry) => entry.id === id);
      label.textContent = position ? position.name : "1 position";
      return;
    }
    label.textContent = `${selected.size} positions`;
  };

  /** The row at a menu index: 0 is the "all" row, the rest are positions. */
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

  const renderMenu = () => {
    // role="presentation" on the hint: it is a label for the list, not a row a
    // listbox may offer as one more option.
    const hint = atLimit()
      ? `<li class="portfolio-positions-hint" role="presentation">${LIMIT_HINT}</li>`
      : "";
    menu.innerHTML = [
      rowHtml(ALL_INDEX, selected.size === 0, ALL_LABEL),
      ...positions.map((position, index) =>
        rowHtml(index + 1, selected.has(position.id), position.name),
      ),
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
    // After renderMenu, so the rows it just wrote are what gets measured.
    floating.place();
    floating.bind();
  };

  /**
   * Flip one row. The "all" row clears the selection rather than adding to it,
   * and clearing the last checked position lands on the same state — so the
   * chart always has something to draw. The two are reported apart through
   * `onChange`'s second argument, because only the caller knows whether it is
   * holding a wider selection than these rows show. Checking one past the
   * palette's last color does nothing at all: the row is already greyed out, so
   * a silent no-op is what it promised.
   */
  const toggle = (index) => {
    let toggled = null;
    if (index === ALL_INDEX) selected = new Set();
    else {
      const position = positionAt(index);
      if (!position) return;
      if (selected.has(position.id)) selected.delete(position.id);
      else if (atLimit()) return;
      else selected.add(position.id);
      toggled = position.id;
    }
    applyLabel();
    renderMenu();
    // A toggle changes the row count and so the height: without this the panel
    // would keep the box it was measured into and drift off its trigger.
    floating.place();
    if (onChange) onChange(value(), toggled);
  };

  // Shared with setOptions(): the highlight is a bare index, so replacing the
  // rows is as able to strand it past the last one as moving it is.
  const clampHighlight = () => {
    highlighted = Math.max(ALL_INDEX, Math.min(positions.length, highlighted));
  };

  const moveHighlight = (delta) => {
    highlighted += delta;
    clampHighlight();
    renderMenu();
  };

  // mousedown, not click: a click on the already-focused trigger fires no focus
  // event, so focus alone could never close an open menu.
  trigger.addEventListener("mousedown", (event) => {
    event.preventDefault();
    if (open) closeMenu();
    else {
      trigger.focus();
      openMenu();
    }
  });

  trigger.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (open) moveHighlight(1);
        else openMenu();
        break;
      case "ArrowUp":
        event.preventDefault();
        if (open) moveHighlight(-1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        // Toggling deliberately leaves the menu open: picking a second position
        // is the normal next step, and reopening for it would be busywork.
        if (open) toggle(highlighted);
        else openMenu();
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          closeMenu();
        }
        break;
      case "Tab":
        closeMenu();
        break;
    }
  });

  // mousedown so it lands before the trigger's focusout closes the menu.
  menu.addEventListener("mousedown", (event) => {
    const option = event.target.closest(".portfolio-positions-option");
    if (!option) return;
    event.preventDefault();
    highlighted = Number(option.dataset.index);
    toggle(highlighted);
  });

  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) closeMenu();
  });

  applyLabel();

  return {
    /**
     * Replace the selectable positions. The caller owns the selection, so ids
     * that no longer exist are left untouched here — `setValue()` is where a
     * pruned selection arrives.
     */
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
    setValue(next) {
      // Capped here as well, so a restored selection cannot seat more lines
      // than a live one is allowed to.
      selected =
        next === POSITIONS_ALL
          ? new Set()
          : new Set([...next].slice(0, PORTFOLIO_MAX_LINES));
      applyLabel();
      if (open) renderMenu();
    },
    getValue() {
      return value();
    },
  };
}
