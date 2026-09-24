/**
 * The portfolio's number and date vocabulary: formatting what the API sends and
 * parsing what the user types.
 *
 * Pure module — no DOM, no `fetch`, no `state`.
 */

import { withEuro } from "./dom.js";

// The API sends the lowercase enum the schema's CHECK constraint holds; the row
// meta line shows it the way the design spells it.
export const KIND_LABELS = new Map([
  ["etf", "ETF"],
  ["fund", "Fund"],
  ["stock", "Stock"],
]);

// Grouped thousands with exactly two decimals (`1,300.00`). `formatCurrency()`
// in dom.js is the invoice side's formatter and has no grouping at all.
const amountFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a number as a grouped amount without any currency symbol.
 *
 * `value === 0` normalizes a negative zero (which the backend's rounding can
 * produce) back to zero, so it never renders as `-0.00`.
 */
export function formatAmount(value) {
  return amountFormat.format(value === 0 ? 0 : value);
}

/** Format an EUR amount with a trailing symbol (`1,389.27 €`). */
export function formatEuro(value) {
  return withEuro(formatAmount(value));
}

/**
 * Format a gain or loss with an explicit sign (`+89.27 €`, `-12.00 €`).
 *
 * The sign is written out and the magnitude formatted separately, so a negative
 * value cannot pick up a second minus from the number formatter.
 */
export function formatSigned(value) {
  const sign = value < 0 ? "-" : "+";
  return withEuro(`${sign}${formatAmount(Math.abs(value))}`);
}

/**
 * Format a percentage with an explicit sign, or an em dash when it is undefined.
 *
 * `gain_pct` is null whenever nothing was ever contributed — there is no basis
 * to measure against, which is not the same as zero.
 */
export function formatPercent(value) {
  if (value === null || value === undefined) return "—";
  const sign = value < 0 ? "-" : "+";
  return `${sign}${Math.abs(value).toFixed(1)} %`;
}

/**
 * Format an ISO day as `DD.MM.YYYY`.
 *
 * Split rather than parsed: no Date is built, so no timezone can shift the day.
 * The invoice side's `formatDate()` renders en-GB `DD/MM/YYYY` and stays as it is.
 */
export function formatDateDots(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

/**
 * Whether a number written with a single kind of separator groups perfectly into
 * thousands (`1.234`, `12,345,678`) — the only shape that cannot be a fraction.
 */
function isGroupedThousands(text, separator) {
  const pattern =
    separator === "," ? /^-?\d{1,3}(,\d{3})+$/ : /^-?\d{1,3}(\.\d{3})+$/;
  return pattern.test(text);
}

/**
 * Parse an amount a user typed, in either German or English notation.
 *
 * The snapshot form is the one place where numbers travel the other way, and the
 * user's own spreadsheet writes `1.234,56` while the app renders `1,234.56` — so
 * both have to read as the same amount. With both separators present the later
 * one is the decimal point. A single kind is ambiguous (`1.234` is thousands,
 * `12.34` a fraction), and is read as grouping only when the digits group
 * perfectly, which no two-decimal fraction does.
 *
 * Returns `null` for a blank field — the API's "carry the previous value
 * forward" signal, which is not the same as zero — and `NaN` for anything
 * unparseable, so a caller can tell the two apart.
 */
export function parseAmountInput(text) {
  const cleaned = String(text ?? "").replace(/[\s\u00a0\u202f\p{Sc}]/gu, "");
  if (cleaned === "") return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? "," : ".";
    normalized = isGroupedThousands(cleaned, separator)
      ? cleaned.split(separator).join("")
      : cleaned.replace(separator, ".");
  }

  // A full-string test rather than parseFloat(), which would read `12abc` as 12
  // and a stray second separator as a silently truncated number.
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

/** Map a signed amount onto its colour class, so the palette stays in CSS. */
export function toneClass(value) {
  if (value > 0) return "is-gain";
  if (value < 0) return "is-loss";
  return "";
}
