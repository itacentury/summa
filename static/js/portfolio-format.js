/**
 * The portfolio's number and date formatting. Pure: no DOM,
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
