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
import { createFloatingMenu } from "./floating-menu.js";

// The value the filter carries while nothing is picked out. Kept here so the
// markup, the storage and the chart agree on one token.
export const POSITIONS_ALL = "all";
const ALL_LABEL = "All positions";

// Index of the leading "all" row, which is not one of the positions.
const ALL_INDEX = 0;

/**
 * Create the position filter bound to `root` (the `.portfolio-positions`
 * element). `onChange(value)` fires only on a user-driven toggle, never on
 * setValue() or setOptions(), and carries either `POSITIONS_ALL` or an array of
 * position ids.
 */
export function createPositionsFilter(root, { onChange } = {}) {
  const trigger = root.querySelector(".portfolio-positions-trigger");
  const label = root.querySelector(".portfolio-positions-label");
  const menu = root.querySelector(".portfolio-positions-menu");

  menu.id = "portfolio-positions-menu";
  trigger.setAttribute("aria-controls", menu.id);

  // The chart card clips its content, so the menu has to be placed against the
  // viewport rather than against the card it lives in.
  const floating = createFloatingMenu(trigger, menu, { minWidth: 190 });

  // The selectable positions in render order, and the ids picked out of them.
  // An empty set *is* "all": the two are never distinct states, so unchecking
  // the last row cannot leave the chart with nothing to draw.
  let positions = [];
  let selected = new Set();
  let highlighted = ALL_INDEX;
  let open = false;

  const value = () => (selected.size === 0 ? POSITIONS_ALL : [...selected]);

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

  const rowHtml = (index, isSelected, name) => `
    <li class="portfolio-positions-option${isSelected ? " is-selected" : ""}${
      index === highlighted ? " is-highlighted" : ""
    }"
        role="option" aria-selected="${isSelected}"
        id="${menu.id}-option-${index}" data-index="${index}">
      <span class="portfolio-positions-check" aria-hidden="true"></span>
      <span class="portfolio-positions-option-label">${escapeHtml(name)}</span>
    </li>
  `;

  const renderMenu = () => {
    menu.innerHTML = [
      rowHtml(ALL_INDEX, selected.size === 0, ALL_LABEL),
      ...positions.map((position, index) =>
        rowHtml(index + 1, selected.has(position.id), position.name),
      ),
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
   * chart always has something to draw.
   */
  const toggle = (index) => {
    if (index === ALL_INDEX) selected = new Set();
    else {
      const position = positionAt(index);
      if (!position) return;
      if (selected.has(position.id)) selected.delete(position.id);
      else selected.add(position.id);
    }
    applyLabel();
    renderMenu();
    // A toggle changes the row count and so the height: without this the panel
    // would keep the box it was measured into and drift off its trigger.
    floating.place();
    if (onChange) onChange(value());
  };

  const moveHighlight = (delta) => {
    highlighted = Math.max(0, Math.min(positions.length, highlighted + delta));
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
      applyLabel();
      if (!open) return;
      renderMenu();
      floating.place();
    },
    setValue(next) {
      selected = next === POSITIONS_ALL ? new Set() : new Set(next);
      applyLabel();
      if (open) renderMenu();
    },
    getValue() {
      return value();
    },
  };
}
