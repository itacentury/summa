/**
 * The portfolio toolbar's depot filter: a small listbox dropdown.
 *
 * Deliberately not an instance of `combobox.js`: that control is a searchable
 * text input whose committed value *is* the option label, while a depot has an
 * id the filter speaks and a name the user reads. The interaction rules below
 * are the ones combobox.js established — read its comments for why each exists.
 */

import { escapeHtml } from "./dom.js";

// The leading row, and the value `state.depotFilter` carries when nothing is
// filtered. Kept here so the markup and the storage agree on one token.
export const DEPOT_ALL = "all";
const ALL_LABEL = "All depots";

/**
 * Create the depot filter bound to `root` (the `.portfolio-depot` element).
 * `onChange(value)` fires only on a user-driven selection, never on setValue().
 */
export function createDepotFilter(root, { onChange } = {}) {
  const trigger = root.querySelector(".portfolio-depot-trigger");
  const label = root.querySelector(".portfolio-depot-label");
  const menu = root.querySelector(".portfolio-depot-menu");

  menu.id = "portfolio-depot-menu";
  trigger.setAttribute("aria-controls", menu.id);

  // Every selectable row in render order: the "all" entry plus one per depot.
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
    // Start on the committed row, so Arrow keys move relative to what is set.
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

  const moveHighlight = (delta) => {
    highlighted = Math.max(
      0,
      Math.min(entries.length - 1, highlighted + delta),
    );
    applyHighlight();
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
        if (open) commit(entries[highlighted].value);
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
    const option = event.target.closest(".portfolio-depot-option");
    if (!option) return;
    event.preventDefault();
    commit(entries[Number(option.dataset.index)].value);
  });

  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) closeMenu();
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
      applyLabel();
      if (open) renderMenu();
    },
    /** Whether a depot id (or the "all" token) is among the current options. */
    hasOption(candidate) {
      return entries.some((entry) => entry.value === candidate);
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
