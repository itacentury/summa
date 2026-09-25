/**
 * The shared dropdown anchoring.
 *
 * happy-dom reports every rect as zero and lays nothing out, so the trigger's
 * rect, the viewport and the panel's own measurements are all fed in. What is
 * worth pinning is the arithmetic those feed: which side the panel opens to,
 * how far it may grow, and that it never leaves the viewport.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFloatingMenu } from "../../static/js/floating-menu.js";

const VIEWPORT = { width: 1000, height: 800 };

/** Mount a trigger/menu pair whose geometry is dictated rather than laid out. */
function mount({ rect, contentHeight = 400, width = 190 } = {}) {
  document.body.innerHTML = `
    <div class="root">
      <button type="button"></button>
      <ul></ul>
    </div>
  `;
  const root = document.querySelector(".root");
  const trigger = document.querySelector("button");
  const menu = document.querySelector("ul");

  trigger.getBoundingClientRect = () => rect;
  Object.defineProperty(menu, "scrollHeight", { get: () => contentHeight });
  Object.defineProperty(menu, "offsetWidth", { get: () => width });

  return { root, trigger, menu };
}

/** A trigger box, defaulting to something small near the top left. */
const at = ({ top = 100, left = 40, width = 120, height = 30 }) => ({
  top,
  left,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

const px = (value) => parseFloat(value);

beforeEach(() => {
  window.innerWidth = VIEWPORT.width;
  window.innerHeight = VIEWPORT.height;
});

describe("createFloatingMenu", () => {
  it("lifts the panel out of its clipping ancestor", () => {
    const { trigger, menu } = mount({ rect: at({}) });
    createFloatingMenu(trigger, menu).place();

    expect(menu.style.position).toBe("fixed");
  });

  it("opens below the trigger while there is room for the whole panel", () => {
    const { trigger, menu } = mount({
      rect: at({ top: 100 }),
      contentHeight: 200,
    });
    createFloatingMenu(trigger, menu, { gap: 6, maxHeight: 260 }).place();

    expect(px(menu.style.top)).toBe(136);
    expect(px(menu.style.maxHeight)).toBe(200);
  });

  it("flips above the trigger when below is the tighter side", () => {
    // 60px left below, 594 above: the panel belongs on top.
    const { trigger, menu } = mount({
      rect: at({ top: 600, height: 140 }),
      contentHeight: 300,
    });
    createFloatingMenu(trigger, menu, { gap: 6, maxHeight: 260 }).place();

    expect(px(menu.style.top)).toBe(600 - 6 - 260);
  });

  it("shrinks to the space it has rather than overflowing it", () => {
    const { trigger, menu } = mount({
      rect: at({ top: 600, height: 40 }),
      contentHeight: 900,
    });
    createFloatingMenu(trigger, menu, {
      gap: 6,
      padding: 8,
      maxHeight: 600,
    }).place();

    // Above is the roomier side: 600 - 6 - 8.
    expect(px(menu.style.maxHeight)).toBe(586);
  });

  it("keeps a right-aligned panel off the left edge", () => {
    const { trigger, menu } = mount({
      rect: at({ left: 10, width: 60 }),
      width: 190,
    });
    createFloatingMenu(trigger, menu, { align: "right", padding: 8 }).place();

    // Aligning to the trigger's right edge would put it at -120.
    expect(px(menu.style.left)).toBe(8);
  });

  it("keeps a left-aligned panel off the right edge", () => {
    const { trigger, menu } = mount({ rect: at({ left: 900 }), width: 190 });
    createFloatingMenu(trigger, menu, { padding: 8 }).place();

    expect(px(menu.style.left)).toBe(VIEWPORT.width - 8 - 190);
  });

  it("widens the panel to a trigger that outgrows the numeric floor", () => {
    const { trigger, menu } = mount({ rect: at({ width: 358 }) });
    createFloatingMenu(trigger, menu, {
      minWidth: 190,
      matchTrigger: true,
    }).place();

    expect(px(menu.style.minWidth)).toBe(358);
  });

  it("keeps the numeric floor under a trigger narrower than it", () => {
    const { trigger, menu } = mount({ rect: at({ width: 120 }) });
    createFloatingMenu(trigger, menu, {
      minWidth: 190,
      matchTrigger: true,
    }).place();

    expect(px(menu.style.minWidth)).toBe(190);
  });

  it("leaves the width to the stylesheet unless asked for a floor", () => {
    const { trigger, menu } = mount({ rect: at({ width: 358 }) });
    createFloatingMenu(trigger, menu).place();

    expect(menu.style.minWidth).toBe("");
  });

  it("pins the panel to the trigger's width and hands it back on release", () => {
    const { trigger, menu } = mount({ rect: at({ width: 358 }) });
    const floating = createFloatingMenu(trigger, menu, { sameWidth: true });
    floating.place();
    floating.bind();

    expect(px(menu.style.width)).toBe(358);

    floating.release();
    expect(menu.style.width).toBe("");
  });

  it("marks the flip on the root, so styling can follow it", () => {
    const { root, trigger, menu } = mount({
      rect: at({ top: 700 }),
      contentHeight: 400,
    });
    const floating = createFloatingMenu(trigger, menu, {
      flipClass: "is-open-up",
      flipRoot: root,
    });

    floating.place();
    expect(root.classList.contains("is-open-up")).toBe(true);

    trigger.getBoundingClientRect = () => at({ top: 100 });
    floating.place();
    expect(root.classList.contains("is-open-up")).toBe(false);
  });

  it("tracks scrolling ancestors, not only the document", () => {
    const { trigger, menu } = mount({ rect: at({}) });
    const listen = vi.spyOn(document, "addEventListener");

    createFloatingMenu(trigger, menu).bind();

    const scroll = listen.mock.calls.find(([type]) => type === "scroll");
    expect(scroll[2]).toBe(true);
    listen.mockRestore();
  });

  it("releases exactly the listeners it bound", () => {
    const { trigger, menu } = mount({ rect: at({}) });
    const drop = vi.spyOn(document, "removeEventListener");
    const floating = createFloatingMenu(trigger, menu);

    floating.bind();
    floating.bind();
    floating.release();

    expect(drop.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(
      1,
    );
    drop.mockRestore();
  });

  it("hands the panel back to the stylesheet on release", () => {
    const { root, trigger, menu } = mount({
      rect: at({ top: 700 }),
      contentHeight: 400,
    });
    const floating = createFloatingMenu(trigger, menu, {
      minWidth: 190,
      flipClass: "is-open-up",
      flipRoot: root,
    });

    floating.place();
    floating.bind();
    floating.release();

    expect(menu.style.position).toBe("");
    expect(menu.style.top).toBe("");
    expect(menu.style.left).toBe("");
    expect(menu.style.maxHeight).toBe("");
    expect(menu.style.minWidth).toBe("");
    expect(root.classList.contains("is-open-up")).toBe(false);
  });
});
