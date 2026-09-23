/**
 * Pre-paint view selection.
 *
 * Loaded as a blocking classic script at the very top of <body>, so it runs
 * before a single pixel of the app markup can be painted. app.js cannot do this:
 * as a module it is deferred, and boot() then waits for the /api/auth/me
 * roundtrip before init() reaches applyViewFromHash(). Without this script a
 * reload on /#portfolio paints the server-rendered invoices markup first and
 * visibly jumps.
 *
 * The position costs it the DOM: nothing below <body> is parsed yet, so the only
 * thing it can set in time is the body's view-mode class — which is enough,
 * because invoices.css hides the invoices view on that class alone. The rest of
 * the shell (the view roots, the topbar title, the active nav item) follows on
 * `interactive`, the first moment the markup exists and still long before the
 * auth check answers.
 *
 * It mirrors only the shell state of setView() in views.js — that module stays
 * the authority, and it loads the view's data a moment later. Only the mode
 * class is spelled out here, because it is needed before the DOM can be asked:
 * the rest is read off the nav item, which carries both the token
 * (`data-view`) and the topbar title (`title`).
 */

(() => {
  // Mirrors BODY_CLASSES in views.js. Invoices is absent there too: it is the
  // default view, and its chrome is the unclassed state.
  const MODE_CLASSES = new Map([
    ["stats", "stats-mode"],
    ["portfolio", "portfolio-mode"],
  ]);

  const view = location.hash.slice(1);
  const mode = MODE_CLASSES.get(view);
  // Nothing to do for the default view: the markup already shows it, and an
  // unknown hash falls back to it in views.js anyway.
  if (!mode) return;

  document.body.classList.add(mode);

  const revealView = () => {
    const items = Array.from(document.querySelectorAll(".nav-item"));
    const target = items.find((item) => item.dataset.view === view);
    const root = document.querySelector(`[data-el="${view}-view"]`);
    if (!target || !root) return;

    document
      .querySelector('[data-el="invoices-view"]')
      .classList.add("is-hidden");
    root.classList.remove("is-hidden");
    document.querySelector('[data-el="topbar-title"]').textContent =
      target.title;
    for (const item of items) item.classList.toggle("active", item === target);
  };

  // `readystatechange` rather than DOMContentLoaded: readyState turns
  // "interactive" as soon as parsing ends, whereas DOMContentLoaded waits for
  // app.js and its module graph.
  if (document.readyState === "loading") {
    document.addEventListener("readystatechange", revealView, { once: true });
    return;
  }
  revealView();
})();
