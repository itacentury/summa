/**
 * Frontend unit tests for the invoice date guard. The date input's `max` only
 * narrows the picker and can't be trusted on its own (on Firefox for Android it
 * is shifted to tomorrow, see capAtToday in dom.js), so `validateInvoiceDate` is
 * the client-side check that a future date is flagged — these cases cover it
 * directly, including the tomorrow that cap lets through.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { todayIso } from "../../static/js/dom.js";
import {
  hideOverlay,
  showOverlay,
  validateInvoiceDate,
} from "../../static/js/modals.js";
import { dayOffset } from "./helpers.js";

describe("showOverlay / hideOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="modal-overlay" data-el="first"></div>
      <div class="modal-overlay" data-el="second"></div>
    `;
    document.body.style.overflow = "";
  });

  const overlay = (name) => document.querySelector(`[data-el="${name}"]`);

  it("activates the overlay and locks the page", () => {
    showOverlay(overlay("first"));

    expect(overlay("first").classList.contains("active")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("keeps the page locked while another overlay is still open", () => {
    showOverlay(overlay("first"));
    showOverlay(overlay("second"));

    hideOverlay(overlay("second"));
    expect(document.body.style.overflow).toBe("hidden");

    hideOverlay(overlay("first"));
    expect(overlay("first").classList.contains("active")).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });
});

function mountDateFixture() {
  document.body.innerHTML = `
    <input type="date" data-el="invoice-date" />
    <p class="field-error is-hidden" data-el="invoice-date-error"></p>
  `;
}

function dateInput() {
  return document.querySelector('[data-el="invoice-date"]');
}

function hintHidden() {
  return document
    .querySelector('[data-el="invoice-date-error"]')
    .classList.contains("is-hidden");
}

describe("validateInvoiceDate", () => {
  beforeEach(mountDateFixture);

  it("accepts today without flagging the field", () => {
    dateInput().value = todayIso();

    expect(validateInvoiceDate()).toBe(false);
    expect(hintHidden()).toBe(true);
    expect(dateInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("flags a future date and shows the hint", () => {
    dateInput().value = dayOffset(1);

    expect(validateInvoiceDate()).toBe(true);
    expect(hintHidden()).toBe(false);
    expect(dateInput().getAttribute("aria-invalid")).toBe("true");
  });

  // Re-validating after a correction must clear the hint again, not leave the
  // form stuck in the invalid state.
  it("clears the hint once the date is corrected", () => {
    dateInput().value = dayOffset(1);
    validateInvoiceDate();

    dateInput().value = dayOffset(-1);

    expect(validateInvoiceDate()).toBe(false);
    expect(hintHidden()).toBe(true);
  });
});
