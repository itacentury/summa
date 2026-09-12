/**
 * Global keyboard shortcuts, modal focus-trap and the shortcut-help overlay.
 *
 * Modal focus behaviour (initial focus, Tab trapping, focus restoration) is
 * driven by a MutationObserver on the `.active` class of every `.modal-overlay`,
 * so the scattered open/close functions in modals.js / bulk.js stay untouched.
 */

import {
  openAddModal,
  openImportModal,
  lockScroll,
  unlockScroll,
} from "./modals.js";
import { openSettingsModal } from "./settings.js";
import { els } from "./dom.js";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open modals, innermost last. Each frame remembers its overlay (to derive
// background inert-ness) and the element focused before it opened (to restore
// focus on close). A stack, not a single ref, so nested modals unwind LIFO.
const modalStack = []; // Array<{ overlay: Element, trigger: Element | null }>

/**
 * Pull every element behind the topmost open modal out of the accessibility
 * tree (and focus/hit-testing), so an AT virtual cursor can't wander behind the
 * dialog. Leaves that overlay, the toast live regions and scripts alone — the
 * toasts keep announcing (e.g. a save error) even while a modal is open.
 * Recomputed from the stack on every open/close, so a lower modal stays inert
 * while a higher one is open and is revealed again when the higher closes.
 */
function topModalOverlay() {
  return modalStack.length ? modalStack[modalStack.length - 1].overlay : null;
}

function refreshInert() {
  const top = topModalOverlay();
  for (const child of document.body.children) {
    if (child.classList.contains("toast") || child.tagName === "SCRIPT")
      continue;
    child.inert = top !== null && child !== top;
  }
}

/**
 * Whether the event target is a field where single-key shortcuts must not fire.
 */
export function isTypingContext(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function activeModal() {
  return topModalOverlay();
}

/**
 * The tab-reachable, visible controls inside a container, in DOM order.
 * Excludes hidden inputs and `display:none` subtrees (no `offsetParent`) so the
 * focus trap never lands on the combobox's hidden value input or a hidden file
 * input.
 */
function getFocusable(container) {
  const nodes = [...container.querySelectorAll(FOCUSABLE_SELECTOR)];
  return nodes.filter((el) => el.type !== "hidden" && el.offsetParent !== null);
}

/**
 * Close a modal the way its own UI would: click its Cancel button (which also
 * resets the form). Overlays without one — the help overlay — just deactivate.
 */
function closeActiveModal(modal) {
  const cancelButton = modal.querySelector('[data-action="cancel"]');
  if (cancelButton) {
    cancelButton.click();
    return;
  }
  modal.classList.remove("active");
  unlockScroll();
}

function toggleShortcutHelp() {
  const overlay = document.querySelector('[data-el="shortcuts-help"]');
  if (!overlay) return;
  if (overlay.classList.toggle("active")) lockScroll();
  else unlockScroll();
}

/**
 * Keep Tab within the modal by wrapping focus around its first/last control.
 */
function trapTab(event, modal) {
  const focusables = getFocusable(modal);
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleGlobalKeydown(event) {
  // `?` toggles the help overlay from anywhere outside a text field, but never
  // on top of a different modal.
  if (event.key === "?" && !isTypingContext(event.target)) {
    const modal = activeModal();
    const helpOverlay = document.querySelector('[data-el="shortcuts-help"]');
    if (!modal || modal === helpOverlay) {
      event.preventDefault();
      toggleShortcutHelp();
    }
    return;
  }

  const modal = activeModal();
  if (modal) {
    if (event.key === "Escape") {
      // Let a component that already handled Escape (an open combobox dropdown)
      // win: it closes first, and a second Escape then closes the modal.
      if (event.defaultPrevented) return;
      event.preventDefault();
      closeActiveModal(modal);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      // Click the visible primary action, not the footer one by position: in the
      // import modal's correction mode the footer Import button is display:none
      // and the real action ("Re-import corrected") lives in the errors panel.
      const primary = [...modal.querySelectorAll(".btn-primary")].find(
        (button) => button.offsetParent !== null,
      );
      primary?.click();
    } else if (event.key === "Tab") {
      trapTab(event, modal);
    }
    return;
  }

  // Global single-key shortcuts: only outside inputs and without modifiers.
  if (isTypingContext(event.target)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  switch (event.key) {
    case "n":
      event.preventDefault();
      openAddModal();
      break;
    case "i":
      event.preventDefault();
      openImportModal();
      break;
    case ",":
      event.preventDefault();
      openSettingsModal();
      break;
    case "/":
      event.preventDefault();
      els().searchInput?.focus();
      break;
  }
}

/**
 * The element to focus when a modal opens: an explicit [data-autofocus] target
 * when present and visible, else the first focusable body control (falling back
 * to the whole overlay). The explicit marker decouples initial focus from DOM
 * order so reordering fields can't silently move it.
 */
function initialFocusTarget(overlay) {
  const marked = overlay.querySelector("[data-autofocus]");
  if (marked && marked.offsetParent !== null) return marked;
  const body = overlay.querySelector(".modal-body");
  return (body && getFocusable(body)[0]) || getFocusable(overlay)[0];
}

function onModalOpen(overlay) {
  modalStack.push({ overlay, trigger: document.activeElement });
  refreshInert();
  initialFocusTarget(overlay)?.focus();
}

function onModalClose(overlay) {
  const index = modalStack.findIndex((frame) => frame.overlay === overlay);
  if (index === -1) return;
  const wasTop = index === modalStack.length - 1;
  const [frame] = modalStack.splice(index, 1);
  // Un-inert before restoring focus: focusing an element still inside an inert
  // subtree (e.g. the bulk-edit trigger in the bulk toolbar) is a no-op. Only
  // the topmost modal's close restores focus, so an out-of-order close never
  // steals it from a still-open modal.
  refreshInert();
  if (wasTop && frame.trigger instanceof HTMLElement) frame.trigger.focus();
}

/**
 * Observe every modal overlay's `.active` toggle so focus is moved into the
 * modal on open and restored to the trigger on close, without touching the
 * open/close functions themselves.
 */
function setupModalFocusManagement() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const overlay = mutation.target;
      const isActive = overlay.classList.contains("active");
      const wasActive = (mutation.oldValue || "")
        .split(/\s+/)
        .includes("active");
      if (isActive && !wasActive) onModalOpen(overlay);
      else if (!isActive && wasActive) onModalClose(overlay);
    }
  });

  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    observer.observe(overlay, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
    });
  });
}

/**
 * Wire the global keydown shortcuts and modal focus management.
 */
export function setupKeyboardListeners() {
  document.addEventListener("keydown", handleGlobalKeydown);
  setupModalFocusManagement();

  document
    .querySelector('[data-el="shortcuts-help"] .modal-close')
    ?.addEventListener("click", toggleShortcutHelp);
}
