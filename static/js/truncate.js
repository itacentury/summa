/**
 * Middle-ellipsis truncation for names whose distinguishing part sits at the end.
 *
 * `text-overflow: ellipsis` always cuts the tail, which is right for store names
 * and categories but wrong for holdings: `… USD (Acc)` and `… USD (Dist)` differ
 * only in the characters CSS throws away first. This module cuts the middle
 * instead, keeping both ends.
 *
 * It is an enhancement, never a replacement: the CSS ellipsis rules stay in
 * place, so a browser that never runs this (or a measurement that is not
 * available yet) still gets tail truncation rather than an overflowing row.
 *
 * Leaf module — imports only from `dom.js`, which is itself a leaf.
 */

import { escapeHtml } from "./dom.js";

const ELLIPSIS = "…";

// A host that shrinks to fit its own text is exactly as wide as that text, but
// reports the width rounded down — so without this a label that fits perfectly
// would be cut. One pixel is the whole of that rounding.
const SUBPIXEL_SLACK = 1;

// The least of its host a name will give up to a sibling badge. Below this the
// badge is asking for more than it is worth, and loses instead.
const MIN_NAME_SHARE = 0.6;

/**
 * Shorten `text` around its middle until `measure` reports it fits `maxWidth`.
 *
 * Pure: `measure` is injected, so the rule is provable without a DOM. Returns
 * the original string when it already fits, and a bare ellipsis when not even
 * one character of each end does.
 */
export function middleTruncate(text, maxWidth, measure) {
  if (measure(text) <= maxWidth) return text;

  const build = (keep) => {
    const head = text.slice(0, Math.ceil(keep / 2));
    const tail =
      keep === 0 ? "" : text.slice(text.length - Math.floor(keep / 2));
    return `${head}${ELLIPSIS}${tail}`;
  };

  // Largest number of kept characters that still fits, by bisection. `low` is
  // always known to fit and `high` always known not to, so the loop terminates.
  let low = 0;
  let high = text.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (measure(build(middle)) <= maxWidth) {
      low = middle;
      continue;
    }
    high = middle;
  }

  return build(low);
}

/**
 * Markup for a truncatable name, to be placed inside the element that carries
 * the width constraint (the one with `overflow: hidden`).
 */
export function truncatableHtml(text) {
  const escaped = escapeHtml(text);
  return `<span data-full="${escaped}">${escaped}</span>`;
}

// One reused 2D context: measuring through it costs no layout, unlike reading
// `scrollWidth` back after every candidate.
let sharedContext = null;

/**
 * A text-width function bound to the element's computed font, or `null` where
 * canvas measurement is unavailable (which is the signal to leave the DOM alone).
 */
function measurerFor(element) {
  if (sharedContext === null) {
    sharedContext =
      document.createElement("canvas").getContext?.("2d") ?? false;
  }
  if (!sharedContext) return null;
  sharedContext.font = window.getComputedStyle(element).font;
  return (text) => sharedContext.measureText(text).width;
}

/** The element's outer width including horizontal margins. */
function outerWidth(element) {
  const style = window.getComputedStyle(element);
  const margins =
    parseFloat(style.marginLeft || 0) + parseFloat(style.marginRight || 0);
  return element.offsetWidth + margins;
}

/**
 * How much room the carrier has inside its host.
 *
 * Measured on the host rather than the carrier: the carrier is inline (so that
 * a sibling badge stays on the same line) and an inline box reports no width of
 * its own. Whatever the host holds besides the carrier is subtracted.
 *
 * Widths come from the layout box (`clientWidth`, `offsetWidth`) rather than
 * `getBoundingClientRect()`, which reports the *transformed* box: a list painted
 * inside a modal that animates in with a `scale()` would be measured at a
 * fraction of the width it settles at, and nothing later would say so.
 */
function availableWidth(carrier, host) {
  const available = host.clientWidth + SUBPIXEL_SLACK;
  let reserved = 0;
  for (const child of host.children) {
    if (child === carrier) continue;
    if (child.classList.contains("visually-hidden")) continue;
    reserved += outerWidth(child);
  }

  // Keeping a wide badge whole would cut the name it annotates down to nothing —
  // and the badge would still be clipped, because the two together never fit. So
  // past this share the name takes the whole host and the badge is the one that
  // runs off the end, which is exactly what the CSS ellipsis does today.
  const remaining = available - reserved;
  if (remaining < available * MIN_NAME_SHARE) return available;
  return remaining;
}

/**
 * Keep the full name in the accessibility tree while the visible text is cut.
 *
 * Without this a screen reader would announce the mangled string — something
 * the CSS ellipsis never does, since it only hides glyphs.
 */
function syncAccessibleName(carrier, host, full, truncated) {
  const existing = host.querySelector(":scope > .visually-hidden");

  if (!truncated) {
    carrier.removeAttribute("aria-hidden");
    carrier.removeAttribute("title");
    existing?.remove();
    return;
  }

  carrier.setAttribute("aria-hidden", "true");
  carrier.title = full;
  if (existing) {
    existing.textContent = full;
    return;
  }
  const spoken = document.createElement("span");
  spoken.className = "visually-hidden";
  spoken.textContent = full;
  carrier.after(spoken);
}

// How often a cut may be measured again after the host settled around it. The
// widths below only ever fall, so this is a guard against a pathological layout,
// not a convergence criterion: two passes settle the cases in this app.
const MAX_SETTLE_PASSES = 4;

/**
 * Re-cut one carrier against its current width. Idempotent, so a widening
 * viewport restores the full name.
 *
 * Every cut is made from `full` against a freshly measured width, never from
 * the text already on screen — which is what keeps a re-run from ratcheting the
 * name ever shorter. The loop exists because a host may be narrower once it no
 * longer holds the full name: where its width comes from its own content (a
 * flex item with an `auto` basis), a shrinking neighbour hands back the pixels
 * it had lent, and the cut would have been made against a width that no longer
 * exists. Re-measuring only ever narrows, so the loop terminates on its own.
 */
export function applyTruncation(carrier) {
  const full = carrier.dataset.full;
  const host = carrier.parentElement;
  if (!full || !host) return;

  const restore = () => {
    carrier.textContent = full;
    syncAccessibleName(carrier, host, full, false);
  };

  carrier.textContent = full;
  const measure = measurerFor(carrier);
  let available = availableWidth(carrier, host);
  if (available <= 0 || !measure) return restore();

  let shortened = middleTruncate(full, available, measure);
  if (shortened === full) return restore();
  carrier.textContent = shortened;

  for (let pass = 1; pass < MAX_SETTLE_PASSES; pass += 1) {
    const settled = availableWidth(carrier, host);
    if (settled >= available) break;
    available = settled;
    shortened = middleTruncate(full, available, measure);
    carrier.textContent = shortened;
  }

  syncAccessibleName(carrier, host, full, shortened !== full);
}

// Roots already being watched, and the width each was last measured at. Keyed
// weakly so a container that goes away takes its observer with it.
const watched = new WeakMap();

/** Re-cut every carrier under `root` against the width it has right now. */
function recut(root) {
  for (const carrier of root.querySelectorAll("[data-full]")) {
    applyTruncation(carrier);
  }
}

/**
 * Re-cut whenever `root` is resized.
 *
 * Only ever called with a container whose width cannot depend on the text
 * inside it — a list that fills its parent, or the viewport. Watching a box that
 * shrinks to fit its own text would oscillate: cutting the text would narrow the
 * box, which would call us back to cut it again.
 */
function watch(root) {
  if (watched.has(root) || typeof ResizeObserver === "undefined") return;

  const observer = new ResizeObserver(([entry]) => {
    // Cutting text can change a root's height, which would call us straight
    // back; only a width change can alter the outcome.
    const width = entry.contentRect.width;
    if (watched.get(root) === width) return;
    watched.set(root, width);
    recut(document);
  });
  watched.set(root, null);
  observer.observe(root);
}

let started = false;

/**
 * Re-cut every carrier under `root` and, on the first call, start keeping the
 * whole document correct as the viewport changes.
 *
 * The viewport is watched rather than each container: it is the one box no
 * amount of truncation can resize, and every name on the page reacts to it.
 */
export function refreshTruncation(root = document) {
  recut(root);

  if (started) return;
  started = true;
  watch(document.documentElement);
  // The first pass measures against the fallback font; the real one changes
  // every width.
  document.fonts?.ready.then(() => recut(document));
}

/**
 * Set a truncatable name on `host` from script, replacing whatever it held.
 */
export function setTruncatableText(host, text) {
  host.innerHTML = truncatableHtml(text);
  applyTruncation(host.firstElementChild);
}
