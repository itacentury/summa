/**
 * The shared listbox wiring: which input opens, moves, activates or closes the
 * menu. What a row does is the caller's, so the callbacks are plain spies here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { bindListboxTrigger } from "../../static/js/listbox.js";

let root;
let trigger;
let menu;
let callbacks;
let isOpen;

beforeEach(() => {
  document.body.innerHTML = `
    <div data-el="root">
      <button data-el="trigger"></button>
      <ul data-el="menu">
        <li class="option" data-index="0">A</li>
        <li class="option" data-index="1">B</li>
      </ul>
    </div>
    <button data-el="outside"></button>
  `;
  root = document.querySelector('[data-el="root"]');
  trigger = document.querySelector('[data-el="trigger"]');
  menu = document.querySelector('[data-el="menu"]');
  isOpen = false;
  callbacks = {
    open: vi.fn(() => {
      isOpen = true;
    }),
    close: vi.fn(() => {
      isOpen = false;
    }),
    move: vi.fn(),
    activate: vi.fn(),
    pick: vi.fn(),
  };
  bindListboxTrigger({
    root,
    trigger,
    menu,
    optionSelector: ".option",
    isOpen: () => isOpen,
    ...callbacks,
  });
});

const key = (name) =>
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true }),
  );

describe("bindListboxTrigger", () => {
  it("toggles on mousedown", () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(callbacks.open).toHaveBeenCalledTimes(1);

    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(callbacks.close).toHaveBeenCalledTimes(1);
  });

  it("opens on ArrowDown, then moves", () => {
    key("ArrowDown");
    expect(callbacks.open).toHaveBeenCalledTimes(1);
    expect(callbacks.move).not.toHaveBeenCalled();

    key("ArrowDown");
    key("ArrowUp");
    expect(callbacks.move.mock.calls).toEqual([[1], [-1]]);
  });

  it("activates the highlighted row only while open", () => {
    key("Enter");
    expect(callbacks.activate).not.toHaveBeenCalled();
    expect(callbacks.open).toHaveBeenCalledTimes(1);

    key(" ");
    expect(callbacks.activate).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and Tab", () => {
    isOpen = true;
    key("Escape");
    expect(callbacks.close).toHaveBeenCalledTimes(1);

    key("Tab");
    expect(callbacks.close).toHaveBeenCalledTimes(2);
  });

  it("picks a clicked row by its index", () => {
    menu
      .querySelector('[data-index="1"]')
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(callbacks.pick).toHaveBeenCalledWith(1);
  });

  it("closes when focus leaves the root", () => {
    const outside = document.querySelector('[data-el="outside"]');
    root.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }),
    );

    expect(callbacks.close).toHaveBeenCalledTimes(1);
  });
});
