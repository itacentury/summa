/**
 * The portfolio's number and date formatting and input parsing. Pure: no DOM,
 * no `fetch`, no `state`.
 */

import { withEuro } from "./dom.js";

export const KIND_LABELS = new Map([
  ["etf", "ETF"],
  ["fund", "Fund"],
  ["stock", "Stock"],
]);

// Grouped with two decimals (`1,300.00`), unlike dom.js's `formatCurrency()`.
const amountFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a number as a grouped amount without a currency symbol. `value === 0`
 * turns the backend's negative zero into `0.00` rather than `-0.00`.
 */
export function formatAmount(value) {
  return amountFormat.format(value === 0 ? 0 : value);
}

/** Format an EUR amount with a trailing symbol (`1,389.27 €`). */
export function formatEuro(value) {
  return withEuro(formatAmount(value));
}

/**
 * Format a gain or loss with an explicit sign (`+89.27 €`, `-12.00 €`). The
 * magnitude is formatted separately so no second minus can appear.
 */
export function formatSigned(value) {
  const sign = value < 0 ? "-" : "+";
  return withEuro(`${sign}${formatAmount(Math.abs(value))}`);
}

/**
 * Format a signed percentage, or an em dash when undefined: `gain_pct` is null
 * when nothing was contributed, which is not the same as zero.
 */
export function formatPercent(value) {
  if (value === null || value === undefined) return "—";
  const sign = value < 0 ? "-" : "+";
  return `${sign}${Math.abs(value).toFixed(1)} %`;
}

/** Format an ISO day as `DD.MM.YYYY`; split, not parsed, so no timezone can shift it. */
export function formatDateDots(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

/** Whether a single-separator number groups perfectly into thousands (`1.234`). */
function isGroupedThousands(text, separator) {
  const pattern =
    separator === "," ? /^-?\d{1,3}(,\d{3})+$/ : /^-?\d{1,3}(\.\d{3})+$/;
  return pattern.test(text);
}

/**
 * Parse a typed amount in German (`1.234,56`) or English (`1,234.56`) notation.
 * With both separators the later one is the decimal point; a single kind counts
 * as grouping only when the digits group perfectly into thousands.
 *
 * Returns `null` for a blank field (the API's "carry forward" signal, not zero)
 * and `NaN` for anything unparseable.
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

  // Not parseFloat(), which would read `12abc` as 12.
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

/** Map a signed amount onto its colour class. */
export function toneClass(value) {
  if (value > 0) return "is-gain";
  if (value < 0) return "is-loss";
  return "";
}

// Mirrors the server's own rule (_require_currency), so a typo costs no round trip.
export function isCurrencyCode(code) {
  return /^[A-Z]{3}$/.test(code);
}
