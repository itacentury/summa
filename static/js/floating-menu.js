/**
 * Anchoring for a dropdown panel that must escape its card.
 *
 * Every card in this app clips its content (`.chart-card`, `.invoices-section`,
 * `.filters-collapsible-inner`, `.modal`), and an `overflow: hidden` ancestor
 * clips its descendants whatever their `z-index` — stacking order only ever
 * applies inside the clip. The way out is to leave the ancestor's containing
 * block, which is what `position: fixed` does; the price is that the panel no
 * longer follows its trigger by itself, so the geometry below is what pays it.
 *
 * This owns placement and nothing else. Open/close state, ARIA, focusout and
 * outside-click stay with each control, because those genuinely differ between
 * a listbox, a multi-select and a combobox.
 */

// Below this a panel is not worth showing, so a cramped viewport gets a
// scrolling stub rather than a sliver.
const MIN_HEIGHT = 80;

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

/**
 * Anchor `menu` to `trigger`.
 *
 * @param {HTMLElement} trigger the element the panel hangs off
 * @param {HTMLElement} menu the panel itself
 * @param {object} [options]
 * @param {"left"|"right"} [options.align] which trigger edge the panel lines up
 *   with before it is clamped into the viewport
 * @param {number} [options.minWidth] floor for the panel's own width; omit to
 *   let its content size it
 * @param {boolean} [options.matchTrigger] take the trigger's width as a floor
 *   too — what `min-width: 100%` would do for a panel that had not left its
 *   container, and cannot do once it is placed against the viewport
 * @param {boolean} [options.sameWidth] pin the panel to exactly the trigger's
 *   width, as a full-width dropdown under a field would be
 * @param {number} [options.maxHeight] ceiling before available space is applied
 * @param {number} [options.gap] distance between trigger and panel
 * @param {number} [options.padding] margin kept clear of every viewport edge
 * @param {string} [options.flipClass] class set on `flipRoot` while the panel
 *   opens upward, for styling that has to follow (a flipped shadow, say)
 * @param {HTMLElement} [options.flipRoot] defaults to the trigger's parent
 * @returns {{place: () => void, bind: () => void, release: () => void}}
 */
export function createFloatingMenu(trigger, menu, options = {}) {
  const {
    align = "left",
    minWidth = null,
    matchTrigger = false,
    sameWidth = false,
    maxHeight = 260,
    gap = 6,
    padding = 8,
    flipClass = null,
    flipRoot = trigger.parentElement,
  } = options;

  let bound = false;

  const place = () => {
    const rect = trigger.getBoundingClientRect();

    // Reset first: a second call must measure the panel's natural size, not the
    // box the previous call squeezed it into. `top: 0` keeps the measurement
    // clear of the bottom edge, which would otherwise shrink it.
    menu.style.position = "fixed";
    menu.style.right = "auto";
    menu.style.bottom = "auto";
    menu.style.top = "0px";
    menu.style.maxWidth = `${window.innerWidth - padding * 2}px`;
    menu.style.maxHeight = `${maxHeight}px`;

    // Recomputed on every call, not once at creation: place() already runs on
    // resize, so a trigger that grows with the layout takes the panel with it.
    const floor = Math.max(minWidth ?? 0, matchTrigger ? rect.width : 0);
    if (floor > 0) menu.style.minWidth = `${floor}px`;
    if (sameWidth) menu.style.width = `${rect.width}px`;

    const spaceBelow = window.innerHeight - rect.bottom - gap - padding;
    const spaceAbove = rect.top - gap - padding;

    // scrollHeight, not offsetHeight: the panel scrolls its own overflow, so
    // offsetHeight is already capped by the max-height set just above.
    const wanted = Math.min(menu.scrollHeight, maxHeight);
    const flipped = wanted > spaceBelow && spaceAbove > spaceBelow;
    if (flipClass && flipRoot) flipRoot.classList.toggle(flipClass, flipped);

    const room = flipped ? spaceAbove : spaceBelow;
    const height = clamp(wanted, MIN_HEIGHT, Math.max(room, MIN_HEIGHT));
    menu.style.maxHeight = `${height}px`;

    const width = menu.offsetWidth;
    const anchored = align === "right" ? rect.right - width : rect.left;
    const maxLeft = Math.max(padding, window.innerWidth - padding - width);
    menu.style.left = `${clamp(anchored, padding, maxLeft)}px`;

    const drawn = Math.min(menu.scrollHeight, height);
    const anchoredTop = flipped ? rect.top - gap - drawn : rect.bottom + gap;
    const maxTop = Math.max(padding, window.innerHeight - padding - drawn);
    menu.style.top = `${clamp(anchoredTop, padding, maxTop)}px`;
  };

  // Capture, so a scrolling ancestor is caught too and not just the document.
  const bind = () => {
    if (bound) return;
    bound = true;
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
  };

  // Closing, so the panel is also handed back to the stylesheet: every
  // property below was written by place(), and leaving them behind would let a
  // panel that is shown by some other means than `.is-open` reappear wherever
  // it last happened to be placed.
  const release = () => {
    if (!bound) return;
    bound = false;
    window.removeEventListener("resize", place);
    document.removeEventListener("scroll", place, true);

    const props = [
      "position",
      "top",
      "left",
      "right",
      "bottom",
      "width",
      "minWidth",
      "maxWidth",
      "maxHeight",
    ];
    props.forEach((prop) => {
      menu.style[prop] = "";
    });
    if (flipClass && flipRoot) flipRoot.classList.remove(flipClass);
  };

  return { place, bind, release };
}
