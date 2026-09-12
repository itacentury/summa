/**
 * Frontend unit tests for the modal focus management in keyboard.js. Initial
 * focus follows the explicit `[data-autofocus]` marker rather than DOM order —
 * that is what keeps the settings dialog off its destructive "Sign out" row —
 * so these cases drive the real path: the MutationObserver on the overlay's
 * `active` class, wired by setupKeyboardListeners().
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setupKeyboardListeners } from "../../static/js/keyboard.js";

function mountFocusFixture() {
  document.body.innerHTML = `
    <button data-el="trigger"></button>
    <div class="modal-overlay" data-el="focus-modal">
      <div class="modal">
        <div class="modal-header">
          <button class="modal-close" data-autofocus></button>
        </div>
        <div class="modal-body">
          <input data-el="first-field" />
          <input data-el="second-field" />
        </div>
      </div>
    </div>
  `;
}

function overlay() {
  return document.querySelector('[data-el="focus-modal"]');
}

function closeButton() {
  return document.querySelector(".modal-close");
}

function firstField() {
  return document.querySelector('[data-el="first-field"]');
}

// MutationObserver callbacks are delivered asynchronously, so every class
// toggle has to be awaited before the resulting focus move is observable.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openModal() {
  overlay().classList.add("active");
  await flush();
}

async function closeModal() {
  overlay().classList.remove("active");
  await flush();
}

describe("modal focus management", () => {
  beforeEach(() => {
    mountFocusFixture();
    // Overlays are observed at setup time, so the fixture must exist first.
    setupKeyboardListeners();
  });

  // keyboard.js keeps the open modals in a module-level stack, so an overlay
  // left open by a failing assertion would leak into the next test.
  afterEach(closeModal);

  it("focuses the marked element instead of the first control in DOM order", async () => {
    await openModal();
    expect(document.activeElement).toBe(closeButton());
  });

  it("falls back to the first focusable body control without a marker", async () => {
    closeButton().removeAttribute("data-autofocus");

    await openModal();
    expect(document.activeElement).toBe(firstField());
  });

  it("skips a marker that is not visible", async () => {
    // happy-dom has no layout engine and reports `offsetParent` as undefined,
    // so the visibility guard only trips when the property is stubbed.
    Object.defineProperty(closeButton(), "offsetParent", { value: null });

    await openModal();
    expect(document.activeElement).toBe(firstField());
  });

  it("restores focus to the trigger on close", async () => {
    const trigger = document.querySelector('[data-el="trigger"]');
    trigger.focus();

    await openModal();
    await closeModal();

    expect(document.activeElement).toBe(trigger);
  });
});
