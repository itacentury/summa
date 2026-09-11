/**
 * Frontend unit tests for the settings dialog. The interesting part is the
 * empty state: it is derived from the visible `[data-setting]` rows at open
 * time, so a deployment without the password gate (sign-out hidden) shows the
 * placeholder instead of a blank body.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  openSettingsModal,
  closeSettingsModal,
  setupSettingsListeners,
} from "../../static/js/settings.js";

function mountSettingsFixture() {
  document.body.innerHTML = `
    <button data-action="open-settings"></button>
    <div class="modal-overlay" data-el="settings-modal">
      <div class="modal modal-sm">
        <button class="modal-close"></button>
        <div class="modal-body">
          <button class="settings-action" data-setting data-el="logout" hidden></button>
          <p class="settings-empty" data-el="settings-empty" hidden></p>
        </div>
      </div>
    </div>
  `;
}

function overlay() {
  return document.querySelector('[data-el="settings-modal"]');
}

function emptyHidden() {
  return document.querySelector('[data-el="settings-empty"]').hidden;
}

describe("settings modal", () => {
  beforeEach(() => {
    mountSettingsFixture();
  });

  it("opens and closes the overlay", () => {
    openSettingsModal();
    expect(overlay().classList.contains("active")).toBe(true);

    closeSettingsModal();
    expect(overlay().classList.contains("active")).toBe(false);
  });

  it("shows the empty state when every setting row is hidden", () => {
    openSettingsModal();
    expect(emptyHidden()).toBe(false);
  });

  it("hides the empty state once a setting row is visible", () => {
    document.querySelector('[data-el="logout"]').hidden = false;

    openSettingsModal();
    expect(emptyHidden()).toBe(true);
  });

  it("re-derives the empty state on every open", () => {
    openSettingsModal();
    closeSettingsModal();
    document.querySelector('[data-el="logout"]').hidden = false;

    openSettingsModal();
    expect(emptyHidden()).toBe(true);
  });

  it("wires the trigger and the close button", () => {
    setupSettingsListeners();

    document.querySelector('[data-action="open-settings"]').click();
    expect(overlay().classList.contains("active")).toBe(true);

    document.querySelector(".modal-close").click();
    expect(overlay().classList.contains("active")).toBe(false);
  });
});
