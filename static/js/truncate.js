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

// A font no element on this page can have. `context.font = …` is a CSS parser,
// not a property write: a value it cannot parse is ignored rather than thrown,
// leaving the previous font bound. Assigning this first and reading it back
// afterwards is the only way to tell an accepted assignment from an ignored one
// — without it, one bad font would silently mismeasure every later carrier with
// whatever was bound before it.
const PROBE_FONT = '1px "summa-font-probe"';

// The probe as the context re-serializes it, which is what a read-back returns.
let probeFont = "";

/**
 * The element's computed font, as a string the canvas accepts. A style read, so
 * it belongs with the widths.
 */
function fontFor(element) {
  const style = window.getComputedStyle(element);
  if (style.font) return style.font;

  // Firefox reports an empty shorthand; the longhands are always populated, and
  // a computed `fontSize` (px) plus `fontFamily` (quoted list) parse as one.
  // Line-height is left out because the canvas ignores it anyway.
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/**
 * A text-width function bound to `font`, or `null` where canvas measurement is
 * unavailable or the font cannot be bound (which is the signal to leave the DOM
 * alone, so the CSS tail ellipsis takes over).
 *
 * Taking the font as a string rather than an element is what lets the widths be
 * read for the whole batch up front: the returned function measures through the
 * shared context, so it is only valid until the next call rebinds the font.
 */
function measurerForFont(font) {
  if (sharedContext === null) {
    sharedContext =
      document.createElement("canvas").getContext?.("2d") ?? false;
    if (sharedContext) {
      sharedContext.font = PROBE_FONT;
      probeFont = sharedContext.font;
    }
  }
  if (!sharedContext) return null;

  sharedContext.font = PROBE_FONT;
  sharedContext.font = font;
  if (sharedContext.font === probeFont) return null;

  return (text) => sharedContext.measureText(text).width;
}

/**
 * How much room the carrier has inside its host.
 *
 * Measured on the host rather than the carrier: the carrier is inline, so that
 * anything the host holds beside it stays on the same line, and an inline box
 * reports no width of its own.
 *
 * The width comes from the layout box (`clientWidth`) rather than
 * `getBoundingClientRect()`, which reports the *transformed* box: a list painted
 * inside a modal that animates in with a `scale()` would be measured at a
 * fraction of the width it settles at, and nothing later would say so.
 */
function availableWidth(host) {
  return host.clientWidth + SUBPIXEL_SLACK;
}

/**
 * Keep the full name in the accessibility tree while the visible text is cut.
 *
 * Without this a screen reader would announce the mangled string — something
 * the CSS ellipsis never does, since it only hides glyphs.
 */
function syncAccessibleName(carrier, host, full, truncated) {
  // Found by its own hook rather than by `.visually-hidden`, which is a
  // repository-wide convention: a host holding one for another reason would
  // otherwise be adopted here and overwritten with the name.
  const existing = host.querySelector(':scope > [data-el="spoken-name"]');

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
  spoken.dataset.el = "spoken-name";
  spoken.textContent = full;
  carrier.after(spoken);
}

// How often a cut may be measured again after the host settled around it. The
// widths below only ever fall, so this is a guard against a pathological layout,
// not a convergence criterion: two passes settle the cases in this app.
const MAX_SETTLE_PASSES = 4;

/**
 * Re-cut every carrier in `carriers` against the width it has right now.
 * Idempotent, so a widening viewport restores the full names.
 *
 * Every cut is made from `full` against a freshly measured width, never from
 * the text already on screen — which is what keeps a re-run from ratcheting a
 * name ever shorter.
 *
 * Reads and writes are kept in separate passes over the whole set rather than
 * per carrier. Writing text and then reading a width forces the browser to lay
 * the document out again before it can answer, so interleaving the two costs
 * one full layout *per name*; batched, the same work costs one layout per pass
 * however many names there are. That matters because the viewport observer
 * re-cuts the whole document on every width change — once per frame while a
 * window is being dragged.
 *
 * Measuring the set together is sound because a cut only ever feeds back into
 * the width of its own row: every carrier here is the only truncatable thing
 * inside its host. That feedback is what the settle passes are for — a host
 * whose width comes from its own content (a flex item with an `auto` basis)
 * gets narrower once it no longer holds the full name, so the cut was made
 * against a width that no longer exists. Re-measuring only ever narrows, so the
 * loop terminates on its own; MAX_SETTLE_PASSES guards a pathological layout,
 * it is not the convergence criterion.
 */
function recutAll(carriers) {
  // Write: back to the full name, so the widths read next are the ones a full
  // name would have.
  const jobs = [];
  for (const carrier of carriers) {
    const full = carrier.dataset.full;
    const host = carrier.parentElement;
    if (!full || !host) continue;
    carrier.textContent = full;
    jobs.push({ carrier, host, full, shortened: full, font: "", available: 0 });
  }
  if (jobs.length === 0) return;

  // Read: one layout for the whole set.
  for (const job of jobs) {
    job.font = fontFor(job.carrier);
    job.available = availableWidth(job.host);
  }

  // Write: pure canvas measurement from here, no layout is read back.
  let settling = [];
  for (const job of jobs) {
    const measure = measurerForFont(job.font);
    // No canvas, or a host with no room yet: the full name stays put.
    if (!measure || job.available <= 0) continue;
    job.shortened = middleTruncate(job.full, job.available, measure);
    if (job.shortened === job.full) continue;
    job.carrier.textContent = job.shortened;
    settling.push(job);
  }

  for (
    let pass = 1;
    pass < MAX_SETTLE_PASSES && settling.length > 0;
    pass += 1
  ) {
    settling = settleOnce(settling);
  }

  for (const job of jobs) {
    syncAccessibleName(
      job.carrier,
      job.host,
      job.full,
      job.shortened !== job.full,
    );
  }
}

/**
 * One settle pass: read every host that is still shrinking, then re-cut those
 * that did. Returns the jobs that moved and so may move again.
 */
function settleOnce(jobs) {
  const settled = jobs.map((job) => availableWidth(job.host));

  const moved = [];
  jobs.forEach((job, index) => {
    if (settled[index] >= job.available) return;
    job.available = settled[index];
    const measure = measurerForFont(job.font);
    if (!measure) return;
    job.shortened = middleTruncate(job.full, job.available, measure);
    job.carrier.textContent = job.shortened;
    moved.push(job);
  });
  return moved;
}

/**
 * Re-cut one carrier against its current width.
 */
export function applyTruncation(carrier) {
  recutAll([carrier]);
}

// Roots already being watched, and the width each was last measured at. Keyed
// weakly so a container that goes away takes its observer with it.
const watched = new WeakMap();

/** Re-cut every carrier under `root` against the width it has right now. */
function recut(root) {
  recutAll(root.querySelectorAll("[data-full]"));
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
