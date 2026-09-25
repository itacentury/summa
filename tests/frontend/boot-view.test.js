/**
 * Pre-paint view selection (static/js/boot-view.js).
 *
 * The script runs once on load, so every case re-imports it through
 * `vi.resetModules()` after mounting the fixture and setting the hash.
 *
 * Three contracts: the mode class must land in the first phase, while the
 * document is still parsing and the markup it needs does not exist yet; it must
 * do nothing at all unless the hash names a real non-default view; and the
 * shell it leaves behind must match the one views.js produces — it derives the
 * rest of the view table from the DOM instead of copying it, and that
 * derivation is what the parity case pins down.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { showPortfolioView } from "../../static/js/views.js";
import { viewState } from "../../static/js/state.js";

vi.mock("../../static/js/stats.js", () => ({ loadStats: vi.fn() }));
vi.mock("../../static/js/portfolio.js", () => ({ loadPortfolio: vi.fn() }));
vi.mock("../../static/js/drawer.js", () => ({ closeMobileSearch: vi.fn() }));

// Mirrors templates/: the nav items carry the `title` the boot script reads,
// and only the invoices view starts visible.
const markup = `
  <div data-el="topbar-title">Invoices</div>
  <nav class="sidebar-nav">
    <button class="nav-item active" data-view="invoices" title="Invoices"></button>
    <button class="nav-item" data-view="stats" title="Statistics"></button>
    <button class="nav-item" data-view="portfolio" title="Portfolio"></button>
  </nav>
  <div data-el="invoices-view"></div>
  <div class="is-hidden" data-el="stats-view"></div>
  <div class="is-hidden" data-el="portfolio-view"></div>
`;

const mount = () => {
  document.body.innerHTML = markup;
  document.body.className = "";
};

const clearHash = () => history.replaceState(null, "", location.pathname);

/**
 * Run the boot script against the current hash and DOM. The suite's document is
 * long past parsing, so both phases run in one go.
 */
const runBootView = async () => {
  vi.resetModules();
  await import("../../static/js/boot-view.js");
};

/**
 * Run the boot script as the browser does: while the document still parses, so
 * only the body class is reachable. Returns the parse-complete trigger.
 */
const runBootViewWhileParsing = async () => {
  Object.defineProperty(document, "readyState", {
    value: "loading",
    configurable: true,
  });
  await runBootView();

  return () => {
    delete document.readyState;
    document.dispatchEvent(new Event("readystatechange"));
  };
};

const visibleViews = () =>
  ["invoices-view", "stats-view", "portfolio-view"].filter(
    (hook) =>
      !document
        .querySelector(`[data-el="${hook}"]`)
        .classList.contains("is-hidden"),
  );

const activeViews = () =>
  [...document.querySelectorAll(".nav-item.active")].map(
    (button) => button.dataset.view,
  );

describe("pre-paint view selection", () => {
  beforeEach(() => {
    mount();
    viewState.currentView = "invoices";
    clearHash();
  });

  it("shows the hashed view before the app boots", async () => {
    location.hash = "portfolio";
    await runBootView();

    expect(visibleViews()).toEqual(["portfolio-view"]);
    expect(activeViews()).toEqual(["portfolio"]);
    expect(document.querySelector('[data-el="topbar-title"]').textContent).toBe(
      "Portfolio",
    );
    expect(document.body.classList.contains("portfolio-mode")).toBe(true);
  });

  it("sets the mode class before the markup exists", async () => {
    location.hash = "portfolio";
    const body = document.body.innerHTML;
    document.body.innerHTML = "";

    const finishParsing = await runBootViewWhileParsing();
    // All the first phase can reach: the views and the nav are still unparsed.
    expect(document.body.className).toBe("portfolio-mode");

    document.body.innerHTML = body;
    finishParsing();

    expect(visibleViews()).toEqual(["portfolio-view"]);
    expect(activeViews()).toEqual(["portfolio"]);
  });

  it("leaves the markup alone for the default view", async () => {
    const before = document.body.innerHTML;

    await runBootView();
    expect(document.body.innerHTML).toBe(before);

    location.hash = "invoices";
    await runBootView();
    expect(document.body.innerHTML).toBe(before);
    expect(document.body.className).toBe("");
  });

  it.each(["nonsense", "a b", "portfolio-view"])(
    "leaves the markup alone for #%s",
    async (hash) => {
      const before = document.body.innerHTML;
      location.hash = hash;

      await runBootView();

      expect(document.body.innerHTML).toBe(before);
      expect(document.body.className).toBe("");
    },
  );

  it("produces the same shell as views.js", async () => {
    location.hash = "portfolio";
    await runBootView();
    const booted = document.body.outerHTML;

    mount();
    showPortfolioView();

    expect(booted).toBe(document.body.outerHTML);
  });
});
