/**
 * Reposition-listener bookkeeping for the floating (position: fixed) combobox
 * menu. `data-menu-float="desktop"` means the menu *may* float, so the scroll
 * listener must follow `shouldFloatMenu()`, not the raw attribute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// dom.js evaluates mobileViewport (a MediaQueryList) at import time; swap in a
// plain object so a test can flip the breakpoint without touching matchMedia.
const { mobileViewport } = vi.hoisted(() => ({
  mobileViewport: { matches: false },
}));

vi.mock("../../static/js/dom.js", async (importOriginal) => ({
  ...(await importOriginal()),
  mobileViewport,
}));

const { createCombobox } = await import("../../static/js/combobox.js");

/** Mount one combobox root, mirroring the `combobox()` macro's filter variant. */
function mountCombobox(menuFloat) {
  document.body.innerHTML = `
    <div class="combobox" data-combobox data-kind="store" data-menu-float="${menuFloat}"
         data-empty-label="All Stores" data-allow-create="false">
      <input type="hidden" data-el="store-filter-${menuFloat || "none"}" />
      <div class="combobox-control">
        <input type="text" class="combobox-input" role="combobox" aria-expanded="false" />
      </div>
      <ul class="combobox-menu" role="listbox"></ul>
    </div>
  `;
  return document.querySelector("[data-combobox]");
}

let documentAdd;
let documentRemove;
let windowAdd;

const scrollListenerCalls = (spy) =>
  spy.mock.calls.filter(([type]) => type === "scroll");
const resizeListenerCalls = (spy) =>
  spy.mock.calls.filter(([type]) => type === "resize");

const openMenu = (input) => input.dispatchEvent(new Event("focus"));
const closeMenu = (input) =>
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

beforeEach(() => {
  documentAdd = vi.spyOn(document, "addEventListener");
  documentRemove = vi.spyOn(document, "removeEventListener");
  windowAdd = vi.spyOn(window, "addEventListener");
});

afterEach(() => {
  vi.restoreAllMocks();
  mobileViewport.matches = false;
});

describe('data-menu-float="desktop"', () => {
  it("skips the scroll listener below the breakpoint but keeps resize", () => {
    mobileViewport.matches = true;
    const root = mountCombobox("desktop");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");

    openMenu(input);

    expect(scrollListenerCalls(documentAdd)).toHaveLength(0);
    expect(resizeListenerCalls(windowAdd)).toHaveLength(1);

    // Leave no live instance behind: an open menu keeps its window-level resize
    // listener, which would answer the next test's resize too.
    closeMenu(input);
  });

  it("binds and releases the scroll listener above the breakpoint", () => {
    const root = mountCombobox("desktop");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");

    openMenu(input);
    expect(scrollListenerCalls(documentAdd)).toHaveLength(1);
    expect(scrollListenerCalls(documentAdd)[0][2]).toBe(true);

    closeMenu(input);
    expect(scrollListenerCalls(documentRemove)).toHaveLength(1);
  });

  it("starts scroll tracking when a resize crosses into desktop", () => {
    mobileViewport.matches = true;
    const root = mountCombobox("desktop");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");
    openMenu(input);
    expect(scrollListenerCalls(documentAdd)).toHaveLength(0);

    mobileViewport.matches = false;
    window.dispatchEvent(new Event("resize"));

    expect(scrollListenerCalls(documentAdd)).toHaveLength(1);

    closeMenu(input);
  });

  it("stops scroll tracking when a resize crosses into mobile", () => {
    const root = mountCombobox("desktop");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");
    const menu = root.querySelector(".combobox-menu");
    openMenu(input);
    expect(scrollListenerCalls(documentAdd)).toHaveLength(1);
    expect(menu.style.position).toBe("fixed");

    mobileViewport.matches = true;
    window.dispatchEvent(new Event("resize"));

    // Assert before closing: unbindReposition() releases the scroll listener
    // too, so a post-close count could not tell the two callers apart.
    expect(scrollListenerCalls(documentRemove)).toHaveLength(1);
    expect(menu.style.position).toBe("");

    closeMenu(input);
  });

  it("starts no settle loop on a resize below the breakpoint", () => {
    mobileViewport.matches = true;
    const root = mountCombobox("desktop");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");
    openMenu(input);

    // Spy after opening: the settle loop is the only rAF user on this path, so
    // any frame scheduled here would be one that can never reach positionMenu().
    const raf = vi.spyOn(window, "requestAnimationFrame");
    window.dispatchEvent(new Event("resize"));

    expect(raf).not.toHaveBeenCalled();

    closeMenu(input);
  });
});

describe('data-menu-float="true"', () => {
  it("binds the scroll listener above the breakpoint and releases it on close", () => {
    const root = mountCombobox("true");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");

    openMenu(input);
    expect(scrollListenerCalls(documentAdd)).toHaveLength(1);
    expect(scrollListenerCalls(documentAdd)[0][2]).toBe(true);
    // One re-places the floating menu, the other re-decides whether it floats.
    expect(resizeListenerCalls(windowAdd)).toHaveLength(2);

    closeMenu(input);
    expect(scrollListenerCalls(documentRemove)).toHaveLength(1);
  });

  it("keeps floating below the breakpoint", () => {
    // The "desktop" mode skips the scroll listener under this exact viewport,
    // so this pins the unconditional short-circuit in shouldFloatMenu().
    mobileViewport.matches = true;
    const root = mountCombobox("true");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");

    openMenu(input);

    expect(scrollListenerCalls(documentAdd)).toHaveLength(1);

    closeMenu(input);
  });
});

describe("data-menu-float unset", () => {
  it("binds no reposition listeners at all", () => {
    const root = mountCombobox("");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");

    openMenu(input);

    expect(scrollListenerCalls(documentAdd)).toHaveLength(0);
    expect(resizeListenerCalls(windowAdd)).toHaveLength(0);

    closeMenu(input);
  });

  it("leaves menu.style untouched while typing", () => {
    const root = mountCombobox("");
    createCombobox(root);
    const input = root.querySelector(".combobox-input");
    const menu = root.querySelector(".combobox-menu");

    openMenu(input);
    // Sentinel: clearing an already-empty property leaves no trace, so mark the
    // style object and check renderMenu() does not wipe it. This menu never
    // floats, so it must not run the re-anchor (and its clear branch) at all.
    menu.style.position = "sticky";
    input.value = "Re";
    input.dispatchEvent(new Event("input"));

    expect(menu.style.position).toBe("sticky");

    closeMenu(input);
  });
});
