/**
 * Combobox (design 4b): a searchable, keyboard-navigable dropdown that replaces
 * the legacy `<input list>`+`<datalist>` / `<select>` category/store controls.
 * The root's `data-kind` ("category" | "store") decides whether options carry a
 * category color dot and which option feed the instance subscribes to.
 *
 * Each instance wraps a hidden `<input>` carrying the original `data-el` hook, so
 * every existing `.value` reader (saveInvoice, saveBulkEdit, buildFilterParams)
 * keeps working unchanged. Leaf-ish module: imports only from `dom.js` and
 * `floating-menu.js`.
 */

import { escapeHtml, categoryColorVar, mobileViewport } from "./dom.js";
import { createFloatingMenu } from "./floating-menu.js";

// Registry of live instances, keyed by the wrapped hidden input's data-el name,
// plus a flat list for fanning category options out to every category instance.
const registry = new Map();
const allComboboxes = [];

/**
 * Escape `text` for innerHTML, wrapping the first case-insensitive occurrence of
 * `query` in <b>. Matching happens on the raw text; each slice is escaped
 * independently so the emitted markup can never inject the raw category name.
 */
export function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return escapeHtml(text);
  const before = text.slice(0, index);
  const match = text.slice(index, index + query.length);
  const after = text.slice(index + query.length);
  return `${escapeHtml(before)}<b>${escapeHtml(match)}</b>${escapeHtml(after)}`;
}

/**
 * Create a combobox controller bound to `root` (a `[data-combobox]` element).
 * `onChange(value)` fires only on user-driven selection, never on setValue().
 */
export function createCombobox(root, { onChange } = {}) {
  const hidden = root.querySelector('input[type="hidden"]');
  const textInput = root.querySelector(".combobox-input");
  const menu = root.querySelector(".combobox-menu");
  const dot = root.querySelector(".combobox-dot");

  const dataEl = hidden.dataset.el;
  const kind = root.dataset.kind || "category";
  const defaultPlaceholder = textInput.placeholder;
  const allowCreate = root.dataset.allowCreate === "true";
  const emptyLabel = root.dataset.emptyLabel || "None";
  // Opt-in: anchor the menu to the viewport (position: fixed) so it can escape a
  // clipping/scrolling ancestor and float over sibling chrome (e.g. the sticky
  // footer in the categorize modal) instead of forcing that ancestor to scroll.
  // "true" floats always; "desktop" floats only above the mobile breakpoint,
  // below which the filter bottom sheet's transform would re-anchor (and then
  // clip) a fixed menu.
  const menuFloatMode = root.dataset.menuFloat || "";
  const shouldFloatMenu = () =>
    menuFloatMode === "true" ||
    (menuFloatMode === "desktop" && !mobileViewport.matches);

  const menuId = `combobox-menu-${dataEl}`;
  menu.id = menuId;
  textInput.setAttribute("aria-controls", menuId);

  let options = [];
  let entries = []; // {value, isCreate} in render order, for keyboard nav
  let highlighted = -1;
  let open = false;

  const updateDot = (value) => {
    if (!dot) return;
    if (value) {
      dot.hidden = false;
      dot.style.background = categoryColorVar(value);
    } else {
      dot.hidden = true;
      dot.style.background = "";
    }
  };

  // Reflect a value into the hidden input and the closed-state display.
  const applyValue = (value) => {
    hidden.value = value;
    textInput.value = value;
    updateDot(value);
  };

  const dotMarkup = () => {
    if (kind !== "category") return "";
    // Color is painted post-insert via the CSSOM (see renderMenu), so a strict
    // style-src CSP without 'unsafe-inline' does not block it.
    return `<span class="combobox-option-dot"></span>`;
  };

  const renderMenu = () => {
    const query = textInput.value.trim();
    const filtered = query
      ? options.filter((option) =>
          option.toLowerCase().includes(query.toLowerCase()),
        )
      : options;

    entries = [{ value: "", isCreate: false }];
    const rows = [
      `<li class="combobox-option${hidden.value ? "" : " is-active"}" role="option" id="${menuId}-option-0" data-index="0">
        ${dotMarkup()}<span class="combobox-option-label combobox-option-empty">${escapeHtml(emptyLabel)}</span>
        ${hidden.value ? "" : '<span class="combobox-check">✓</span>'}
      </li>`,
    ];

    filtered.forEach((option) => {
      const index = entries.length;
      entries.push({ value: option, isCreate: false });
      const active = option === hidden.value;
      rows.push(
        `<li class="combobox-option${active ? " is-active" : ""}" role="option" id="${menuId}-option-${index}" data-index="${index}">
          ${dotMarkup()}<span class="combobox-option-label">${highlightMatch(option, query)}</span>
          ${active ? '<span class="combobox-check">✓</span>' : ""}
        </li>`,
      );
    });

    const exactMatch = options.some(
      (option) => option.toLowerCase() === query.toLowerCase(),
    );
    if (allowCreate && query && !exactMatch) {
      const index = entries.length;
      entries.push({ value: query, isCreate: true });
      rows.push('<li class="combobox-divider" role="presentation"></li>');
      rows.push(
        `<li class="combobox-option combobox-option-create" role="option" id="${menuId}-option-${index}" data-index="${index}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span class="combobox-option-label">Create category “${escapeHtml(query)}”</span>
        </li>`,
      );
    }

    menu.innerHTML = rows.join("");
    // Paint each option's dot via the CSSOM; entries[] maps the row index to its
    // value, and only category comboboxes render dots.
    menu.querySelectorAll(".combobox-option").forEach((element) => {
      const dot = element.querySelector(".combobox-option-dot");
      if (!dot) return;
      const value = entries[Number(element.dataset.index)].value;
      dot.style.background = value
        ? categoryColorVar(value)
        : "var(--border-color)";
    });
    applyHighlight();
    // Re-anchor a floating menu whenever its contents (and thus height) change.
    if (menuFloatMode && open) syncMenuPosition();
  };

  const applyHighlight = () => {
    let activeId = "";
    menu.querySelectorAll(".combobox-option").forEach((element) => {
      const isOn = Number(element.dataset.index) === highlighted;
      element.classList.toggle("is-highlighted", isOn);
      element.setAttribute("aria-selected", isOn ? "true" : "false");
      if (isOn) {
        activeId = element.id;
        element.scrollIntoView({ block: "nearest" });
      }
    });
    if (activeId) textInput.setAttribute("aria-activedescendant", activeId);
    else textInput.removeAttribute("aria-activedescendant");
  };

  // --- Floating (position: fixed) menu, opt-in via data-menu-float ------------
  // Placement is floating-menu.js's; what stays here is when to float at all.
  const floating = menuFloatMode
    ? createFloatingMenu(root.querySelector(".combobox-control"), menu, {
        sameWidth: true,
        maxHeight: 240,
        gap: 4,
      })
    : null;

  // Apply or drop the fixed anchoring, so crossing the breakpoint while the menu
  // is open never leaves a stale inline position behind. The scroll listener
  // bind() adds is only wanted while the menu actually floats: in "desktop" mode
  // below the breakpoint it would just rewrite inline styles on every scroll of
  // the bottom sheet.
  const syncMenuPosition = () => {
    if (!shouldFloatMenu()) {
      floating.release();
      return;
    }
    floating.place();
    floating.bind();
  };

  const reposition = () => {
    if (open) syncMenuPosition();
  };

  // A resize is not the end of the layout change it triggers: chrome above the
  // control keeps transitioning for a few hundred ms afterwards (toolbar button
  // paddings, the filter panel's row track) and drags the control with it, so
  // the rect read on the event itself is stale. Keep re-anchoring for the length
  // of those transitions. A resize mid-settle only extends the deadline, so a
  // drag-resize still runs a single loop. Like the scroll listener, the loop
  // runs only while the menu actually floats: otherwise every frame would just
  // rewrite empty inline styles.
  // 350ms is not arbitrary: it has to outlast every transition a resize can
  // start on chrome above the control — `--transition` (0.2s, variables.css),
  // the `.filters-collapsible` row track (0.3s, filters.css) and
  // `modal-slide-up` (0.3s, modals.css). Raise it if any of those grows.
  const settleDuration = 350;
  let settleDeadline = 0;
  let settling = false;

  const settleMenuPosition = () => {
    if (!shouldFloatMenu()) return;
    settleDeadline = performance.now() + settleDuration;
    if (settling) return;
    settling = true;
    const step = () => {
      if (!open || !shouldFloatMenu() || performance.now() >= settleDeadline) {
        settling = false;
        return;
      }
      syncMenuPosition();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // resize stays bound whenever the menu may float: it is the event that flips
  // shouldFloatMenu(), so it has to re-evaluate the floating state too. It is
  // deliberately not mobileViewport's "change" event (which stats.js uses for
  // the same breakpoint): a resize that never crosses the breakpoint still
  // moves the control's rect, and every crossing fires a resize anyway.
  const onViewportResize = () => {
    reposition();
    settleMenuPosition();
  };

  const bindReposition = () => {
    window.addEventListener("resize", onViewportResize);
  };

  const unbindReposition = () => {
    window.removeEventListener("resize", onViewportResize);
    floating.release();
  };

  const openMenu = () => {
    if (open) return;
    open = true;
    root.classList.add("is-open");
    textInput.setAttribute("aria-expanded", "true");
    renderMenu();
    // Start the highlight on the current value's row when one is selected.
    const current = entries.findIndex((entry) => entry.value === hidden.value);
    highlighted = current >= 0 ? current : 0;
    applyHighlight();
    if (menuFloatMode) bindReposition();
  };

  // Close the menu and restore the display to the committed value (a typed but
  // uncommitted query must not linger in the field).
  const closeMenu = () => {
    if (!open) return;
    open = false;
    root.classList.remove("is-open");
    textInput.setAttribute("aria-expanded", "false");
    textInput.removeAttribute("aria-activedescendant");
    highlighted = -1;
    if (menuFloatMode) unbindReposition();
    applyValue(hidden.value);
  };

  const commit = (value) => {
    applyValue(value);
    open = false;
    root.classList.remove("is-open");
    textInput.setAttribute("aria-expanded", "false");
    textInput.removeAttribute("aria-activedescendant");
    highlighted = -1;
    if (menuFloatMode) unbindReposition();
    if (onChange) onChange(value);
  };

  const moveHighlight = (delta) => {
    if (entries.length === 0) return;
    const next = highlighted < 0 ? 0 : highlighted + delta;
    highlighted = Math.max(0, Math.min(entries.length - 1, next));
    applyHighlight();
  };

  // Clicking anywhere on the control (input, icon, dot, chevron) toggles the
  // menu, mirroring a native <select>. focus alone can't do this: it only fires
  // on a focus change, so a click on the already-focused field would be ignored.
  root
    .querySelector(".combobox-control")
    .addEventListener("mousedown", (event) => {
      // While open, a click elsewhere on the control (chevron, dot, icon) closes
      // it; a click inside the input just repositions the caret in the typed
      // query, so let it through untouched and keep the menu open.
      if (open) {
        if (event.target === textInput) return;
        event.preventDefault();
        closeMenu();
        return;
      }
      // Menu closed: route the click to the input. If it isn't focused yet,
      // focusing it opens the menu via the focus handler; if it's already
      // focused (e.g. after Escape), focus won't refire, so open explicitly.
      if (event.target !== textInput) event.preventDefault();
      if (document.activeElement === textInput) openMenu();
      else textInput.focus();
    });

  textInput.addEventListener("focus", openMenu);
  textInput.addEventListener("input", () => {
    open = true;
    root.classList.add("is-open");
    renderMenu();
    // Highlight the first real entry (match or create row) when there's a query,
    // so Enter commits it instead of the empty "None"/"All" row at index 0.
    const query = textInput.value.trim();
    highlighted = query && entries.length > 1 ? 1 : 0;
    applyHighlight();
  });

  textInput.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openMenu();
        else moveHighlight(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveHighlight(-1);
        break;
      case "Enter": {
        // Always suppress the implicit form submit while the combobox has focus.
        event.preventDefault();
        const entry = entries[highlighted];
        if (open && entry) commit(entry.value);
        break;
      }
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

  menu.addEventListener("mousedown", (event) => {
    // mousedown (not click) so it fires before the input's blur/focusout.
    const option = event.target.closest(".combobox-option");
    if (!option) return;
    event.preventDefault();
    const entry = entries[Number(option.dataset.index)];
    if (entry) commit(entry.value);
  });

  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) closeMenu();
  });

  const instance = {
    root,
    kind,
    setOptions(values) {
      options = values;
      if (open) renderMenu();
    },
    hasOption(value) {
      return options.includes(value);
    },
    setValue(value) {
      applyValue(value || "");
    },
    // Override the placeholder shown while the field is empty; a falsy value
    // restores the template default. Used to signal a mixed bulk-edit selection.
    setPlaceholder(text) {
      textInput.placeholder = text || defaultPlaceholder;
    },
    getValue() {
      return hidden.value;
    },
  };

  registry.set(dataEl, instance);
  allComboboxes.push(instance);
  return instance;
}

/** Look up a live combobox instance by its wrapped hidden input's data-el name. */
export function getCombobox(dataEl) {
  return registry.get(dataEl);
}

/** Feed the category option list to every category combobox instance. */
export function setCategoryOptions(categories) {
  allComboboxes.forEach((instance) => {
    if (instance.kind === "category") instance.setOptions(categories);
  });
}

/**
 * Instantiate every `[data-combobox]` in the document. `onChangeByEl` maps a
 * hidden input's data-el name to its selection callback (kept here, in the app
 * wiring, so this module stays free of feature-module imports).
 */
export function setupComboboxes(onChangeByEl = {}) {
  document.querySelectorAll("[data-combobox]").forEach((root) => {
    const dataEl = root.querySelector('input[type="hidden"]').dataset.el;
    createCombobox(root, { onChange: onChangeByEl[dataEl] });
  });
}
