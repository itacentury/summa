/**
 * Frontend unit tests for the settings dialog. Its own job is small — open,
 * close, wire the triggers — and the portfolio section it now carries is only
 * reached when that section is actually mounted, which this fixture omits on
 * purpose.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
          <button class="settings-action" data-el="logout" hidden></button>
        </div>
      </div>
    </div>
  `;
}

function overlay() {
  return document.querySelector('[data-el="settings-modal"]');
}

describe("settings modal", () => {
  beforeEach(() => {
    mountSettingsFixture();
    global.fetch = vi.fn();
  });

  it("opens and closes the overlay", () => {
    openSettingsModal();
    expect(overlay().classList.contains("active")).toBe(true);

    closeSettingsModal();
    expect(overlay().classList.contains("active")).toBe(false);
  });

  it("leaves the portfolio section alone when it is not mounted", () => {
    setupSettingsListeners();
    openSettingsModal();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("wires the trigger and the close button", () => {
    setupSettingsListeners();

    document.querySelector('[data-action="open-settings"]').click();
    expect(overlay().classList.contains("active")).toBe(true);

    document.querySelector(".modal-close").click();
    expect(overlay().classList.contains("active")).toBe(false);
  });
});
