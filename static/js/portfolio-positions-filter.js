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
import { setTruncatableText } from "./truncate.js";

// The value the filter carries while nothing is picked out. Kept here so the
// markup, the storage and the chart agree on one token.
export const POSITIONS_ALL = "all";
const ALL_LABEL = "Total portfolio";

// Index of the leading "all" row, which is not one of the positions.
const ALL_INDEX = 0;

/**
 * Shown under the rows once the palette is spent, so the greyed-out rows say
 * why rather than just failing to respond. Picks the caller is holding off
 * screen are named, because without them the ceiling would look wrong: it bites
 * while fewer than `PORTFOLIO_MAX_LINES` rows are checked.
 */
const limitHint = (hidden) =>
  hidden === 0
    ? `Max. ${PORTFOLIO_MAX_LINES} lines`
    : `Max. ${PORTFOLIO_MAX_LINES} lines · ${hidden} in other depots`;

/**
 * The reset row's label. Always plural: the row only appears once the hidden
 * picks alone have spent the whole palette.
 */
const resetLabel = (hidden) => `Clear ${hidden} picks in other depots`;

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
 *
 * That wider selection is also why the reset needs a second row of its own:
 * once the hidden picks alone have spent the palette, the "all" row is checked
 * and so reads as the state in force rather than as the way out of it.
 *
 * Of that wider selection the control is told one thing, `setValue()`'s `hidden`
 * count: the ceiling is the palette's and applies to the whole of it, so
 * counting only these rows would let a pick evict an off-screen line with
 * nothing greyed out to say so.
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

  // How many of the caller's picks this payload has no row for. Not part of
  // `selected`: they are not togglable here and must never reach `value()`.
  let hiddenCount = 0;

  const value = () => (selected.size === 0 ? POSITIONS_ALL : [...selected]);

  // The chart draws one palette color per line, so the palette is the ceiling:
  // a further line could only repeat a color another holding already owns. The
  // hidden picks are counted because they hold colors too.
  const atLimit = () => selected.size + hiddenCount >= PORTFOLIO_MAX_LINES;

  // The one state the rows themselves offer no way out of: every one of them is
  // greyed out and none is checked, so there is neither a row to take nor a row
  // to give back. Anywhere else the "all" row shows unchecked and is remedy
  // enough.
  const resetShown = () => selected.size === 0 && atLimit();

  // Seated after the last position, so it joins the same index scheme the
  // keyboard and the click delegation already walk.
  const resetIndex = () => (resetShown() ? positions.length + 1 : -1);

  // Counts only the rows on screen, deliberately unlike atLimit(): the label
  // names the lines this chart draws, and it draws no hidden one.
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

  // Written on one line so its text node is the label exactly, the way the hint
  // row's is.
  const resetHtml = () => {
    const index = resetIndex();
    const highlight = index === highlighted ? " is-highlighted" : "";
    return `<li class="portfolio-positions-reset${highlight}" role="option" aria-selected="false" id="${menu.id}-option-${index}" data-index="${index}">${resetLabel(hiddenCount)}</li>`;
  };

  const renderMenu = () => {
    // role="presentation" on the hint: it is a label for the list, not a row a
    // listbox may offer as one more option.
    const hint = atLimit()
      ? `<li class="portfolio-positions-hint" role="presentation">${limitHint(hiddenCount)}</li>`
      : "";
    menu.innerHTML = [
      rowHtml(ALL_INDEX, selected.size === 0, ALL_LABEL),
      ...positions.map((position, index) =>
        rowHtml(index + 1, selected.has(position.id), position.name),
      ),
      // Above the hint, which is sticky and has to stay the last element.
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
   * a silent no-op is what it promised — and because the hidden picks count
   * towards the ceiling, that refusal covers them too, rather than leaving the
   * caller to evict one of them without a row to show for it. The trailing
   * reset row, shown only while that refusal covers every row at once, is the
   * "all" row's second entrance rather than a case of its own.
   */
  const toggle = (index) => {
    let toggled = null;
    // Read before the selection is cleared: the reset row's index is derived
    // from the very state that clearing ends.
    const isReset = index === resetIndex();
    if (index === ALL_INDEX || isReset) {
      selected = new Set();
      // The row is about to stop being rendered, so the highlight may not stay
      // on it.
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
    // A toggle changes the row count and so the height: without this the panel
    // would keep the box it was measured into and drift off its trigger.
    floating.place();
    if (onChange) onChange(value(), toggled);
  };

  // Shared with setOptions(): the highlight is a bare index, so replacing the
  // rows is as able to strand it past the last one as moving it is.
  const clampHighlight = () => {
    const last = positions.length + (resetShown() ? 1 : 0);
    highlighted = Math.max(ALL_INDEX, Math.min(last, highlighted));
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
    const option = event.target.closest(
      ".portfolio-positions-option, .portfolio-positions-reset",
    );
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
    /**
     * Show `next` as the checked rows, with `hidden` naming how many further
     * picks the caller holds that these rows cannot show. Those spend palette
     * slots all the same, so they raise the ceiling these rows are measured
     * against — see `atLimit()`.
     */
    setValue(next, { hidden = 0 } = {}) {
      hiddenCount = hidden;
      // Capped here as well, so a restored selection cannot seat more lines
      // than a live one is allowed to — the hidden ones having been served
      // first, as the caller orders them.
      selected =
        next === POSITIONS_ALL
          ? new Set()
          : new Set(
              [...next].slice(0, Math.max(0, PORTFOLIO_MAX_LINES - hidden)),
            );
      applyLabel();
      // The reset row comes and goes with `hidden`, so the highlight can be
      // stranded past the last row by a mere recount.
      clampHighlight();
      if (open) renderMenu();
    },
    getValue() {
      return value();
    },
  };
}
