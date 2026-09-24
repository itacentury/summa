/**
 * The keyboard and pointer wiring the portfolio's listbox dropdowns share.
 *
 * The interaction rules are the ones combobox.js established — read its
 * comments for why each exists. What a row does when chosen stays with the
 * caller: the depot filter commits one value, the positions filter toggles.
 */

/**
 * Wire `trigger`, `menu` and `root` (the element holding both).
 *
 * `activate()` acts on the highlighted row, `pick(index)` on a clicked one.
 */
export function bindListboxTrigger({
  root,
  trigger,
  menu,
  optionSelector,
  isOpen,
  open,
  close,
  move,
  activate,
  pick,
}) {
  // mousedown, not click: a click on the already-focused trigger fires no focus
  // event, so focus alone could never close an open menu.
  trigger.addEventListener("mousedown", (event) => {
    event.preventDefault();
    if (isOpen()) {
      close();
      return;
    }
    trigger.focus();
    open();
  });

  trigger.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (isOpen()) move(1);
        else open();
        break;
      case "ArrowUp":
        event.preventDefault();
        if (isOpen()) move(-1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (isOpen()) activate();
        else open();
        break;
      case "Escape":
        if (isOpen()) {
          event.preventDefault();
          close();
        }
        break;
      case "Tab":
        close();
        break;
    }
  });

  // mousedown so it lands before the trigger's focusout closes the menu.
  menu.addEventListener("mousedown", (event) => {
    const option = event.target.closest(optionSelector);
    if (!option) return;
    event.preventDefault();
    pick(Number(option.dataset.index));
  });

  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) close();
  });
}
