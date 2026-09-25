/**
 * The portfolio toolbar's depot filter: a small listbox dropdown. Not a
 * `combobox.js` instance, because a depot's value (id) differs from its label.
 */

import { escapeHtml } from "./dom.js";
import { bindListboxTrigger } from "./listbox.js";

// Also the value `portfolioState.depotFilter` carries when nothing is filtered.
export const DEPOT_ALL = "all";
const ALL_LABEL = "All depots";

/**
 * Create the depot filter bound to `root`. `onChange(value)` fires only on a
 * user-driven selection, never on setValue().
 */
export function createDepotFilter(root, { onChange } = {}) {
  const trigger = root.querySelector(".portfolio-depot-trigger");
  const label = root.querySelector(".portfolio-depot-label");
  const menu = root.querySelector(".portfolio-depot-menu");

  menu.id = "portfolio-depot-menu";
  trigger.setAttribute("aria-controls", menu.id);

  let entries = [{ value: DEPOT_ALL, name: ALL_LABEL }];
  let value = DEPOT_ALL;
  let highlighted = 0;
  let open = false;

  const currentEntry = () =>
    entries.find((entry) => entry.value === value) ?? entries[0];

  const applyLabel = () => {
    label.textContent = currentEntry().name;
  };

  const applyHighlight = () => {
    let activeId = "";
    menu.querySelectorAll(".portfolio-depot-option").forEach((element) => {
      const isOn = Number(element.dataset.index) === highlighted;
      element.classList.toggle("is-highlighted", isOn);
      element.setAttribute("aria-selected", isOn ? "true" : "false");
      if (isOn) activeId = element.id;
    });
    if (activeId) trigger.setAttribute("aria-activedescendant", activeId);
    else trigger.removeAttribute("aria-activedescendant");
  };

  const renderMenu = () => {
    menu.innerHTML = entries
      .map(
        (entry, index) => `
          <li class="portfolio-depot-option${entry.value === value ? " is-active" : ""}"
              role="option" id="${menu.id}-option-${index}" data-index="${index}">
            <span class="portfolio-depot-option-label">${escapeHtml(entry.name)}</span>
          </li>
        `,
      )
      .join("");
    applyHighlight();
  };

  const closeMenu = () => {
    if (!open) return;
    open = false;
    root.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
  };

  const openMenu = () => {
    if (open) return;
    open = true;
    root.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    // Start on the committed row.
    highlighted = Math.max(
      0,
      entries.findIndex((entry) => entry.value === value),
    );
    renderMenu();
  };

  const commit = (next) => {
    closeMenu();
    if (next === value) return;
    value = next;
    applyLabel();
    if (onChange) onChange(value);
  };

  // Also needed by setOptions(): replacing the rows can strand the index.
  const clampHighlight = () => {
    highlighted = Math.max(0, Math.min(entries.length - 1, highlighted));
  };

  const moveHighlight = (delta) => {
    highlighted += delta;
    clampHighlight();
    applyHighlight();
  };

  bindListboxTrigger({
    root,
    trigger,
    menu,
    optionSelector: ".portfolio-depot-option",
    isOpen: () => open,
    open: openMenu,
    close: closeMenu,
    move: moveHighlight,
    activate: () => commit(entries[highlighted].value),
    pick: (index) => commit(entries[index].value),
  });

  applyLabel();

  return {
    /** Replace the depot list, keeping the current selection if it survives. */
    setOptions(depots) {
      entries = [
        { value: DEPOT_ALL, name: ALL_LABEL },
        ...depots.map((depot) => ({
          value: String(depot.id),
          name: depot.name,
        })),
      ];
      clampHighlight();
      applyLabel();
      if (open) renderMenu();
    },
    setValue(next) {
      value = next;
      applyLabel();
    },
    getValue() {
      return value;
    },
  };
}
