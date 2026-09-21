/**
 * Model picker for the AI Category Suggestions modal.
 *
 * The chosen model persists per-device in `localStorage` and is read by
 * `categorize.js` when it requests suggestions. Selecting a model fires the
 * optional `onChange` callback so an open modal can re-run its analysis live.
 */

import { createFloatingMenu } from "./floating-menu.js";

const STORAGE_KEY = "summa.aiModel";
const DEFAULT_KEY = "haiku";

// The single source of truth for the picker: option copy, trigger label, and
// the set of valid stored keys all derive from this list.
const MODELS = [
  {
    key: "haiku",
    name: "Claude Haiku",
    description: "Fast & low-cost · default",
  },
  {
    key: "sonnet",
    name: "Claude Sonnet",
    description: "More accurate on ambiguous stores",
  },
  { key: "opus", name: "Claude Opus", description: "Best quality · slowest" },
];

/**
 * Return the stored model key, validated against the known models. Falls back
 * to the default for a missing or unrecognized value.
 */
export function getAiModel() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return MODELS.some((model) => model.key === stored) ? stored : DEFAULT_KEY;
}

function modelByKey(key) {
  return MODELS.find((model) => model.key === key) || MODELS[0];
}

/**
 * Wire the header trigger and its dropdown menu.
 *
 * @param {Function} [onChange] - Called with the newly selected model key after
 *   a selection is committed, so a caller can re-run an open modal live.
 */
export function setupModelPicker(onChange = null) {
  const root = document.querySelector('[data-el="model-picker"]');
  if (!root) return;

  const trigger = root.querySelector('[data-el="model-picker-trigger"]');
  const label = root.querySelector('[data-el="model-picker-label"]');
  const menu = root.querySelector('[data-el="model-picker-menu"]');

  // Right-aligned to the trigger and clamped into the viewport; the modal that
  // holds this clips its content, so the panel is placed against the viewport.
  // Its width stays with the stylesheet.
  const floating = createFloatingMenu(trigger, menu, {
    align: "right",
    maxHeight: 320,
    flipClass: "is-open-up",
    flipRoot: root,
  });

  const syncSelection = () => {
    const current = getAiModel();
    label.textContent = modelByKey(current).name;
    menu.querySelectorAll("[data-model-option]").forEach((option) => {
      const isSelected = option.dataset.modelOption === current;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-checked", isSelected ? "true" : "false");
      // Roving tabindex: the selected option is the menu's single tab stop.
      option.tabIndex = isSelected ? 0 : -1;
    });
  };

  // Move keyboard focus onto an option without committing a selection (arrow
  // navigation): only the focused option stays in the tab order.
  const focusOption = (option) => {
    menu.querySelectorAll("[data-model-option]").forEach((other) => {
      other.tabIndex = other === option ? 0 : -1;
    });
    option.focus();
  };

  const closeMenu = () => {
    if (!root.classList.contains("is-open")) return;
    root.classList.remove("is-open");
    root.classList.remove("is-open-up");
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    floating.release();
  };

  const onOutside = (event) => {
    if (!root.contains(event.target)) closeMenu();
  };

  const openMenu = () => {
    root.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    floating.place();
    floating.bind();
    const selected = menu.querySelector(
      `[data-model-option="${getAiModel()}"]`,
    );
    if (selected) focusOption(selected);
  };

  trigger.addEventListener("click", () => {
    if (root.classList.contains("is-open")) closeMenu();
    else openMenu();
  });

  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-model-option]");
    if (!option) return;
    const key = option.dataset.modelOption;
    localStorage.setItem(STORAGE_KEY, key);
    syncSelection();
    closeMenu();
    if (onChange) onChange(key);
  });

  // Arrow / Home / End move focus between options (roving tabindex). Enter and
  // Space need no handling: the options are native buttons, so activation fires
  // the click handler above.
  menu.addEventListener("keydown", (event) => {
    const options = [...menu.querySelectorAll("[data-model-option]")];
    const current = options.indexOf(document.activeElement);
    if (current === -1) return;

    const lastIndex = options.length - 1;
    let next;
    if (event.key === "ArrowDown")
      next = current === lastIndex ? 0 : current + 1;
    else if (event.key === "ArrowUp")
      next = current === 0 ? lastIndex : current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = lastIndex;
    else return;

    event.preventDefault();
    focusOption(options[next]);
  });

  // Consume Esc while open so the first Esc closes the picker rather than the
  // whole modal (keyboard.js runs a global modal-stack Esc handler).
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.classList.contains("is-open")) {
      event.stopPropagation();
      event.preventDefault();
      closeMenu();
      trigger.focus();
    }
  });

  syncSelection();
}
