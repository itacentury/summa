"""Refresh the benchmark series in ``benchmark_prices`` from a public feed.

Run by the ``benchmark`` compose service or by hand. The default is the MSCI
World via the Xetra-listed iShares ETF, so it is quoted in EUR and free of
EUR/USD movement; the chart rebases the closes, so their level never shows.

A failure exits non-zero so the compose loop retries after an hour; meanwhile
the API falls back to the ``is_benchmark_fallback`` position.
"""

import argparse
import json
import sqlite3
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from scripts.portfolio_db import default_database_path, open_database
from summa import config
from summa.portfolio import CLOSE_DIGITS

CHART_URL: Final[str] = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
DEFAULT_RANGE: Final[str] = "2y"
DEFAULT_INTERVAL: Final[str] = "1wk"
DEFAULT_TIMEOUT: Final[float] = 15.0
RANGE_TOKENS: Final[tuple[str, ...]] = ("1y", "2y", "5y", "10y", "max")
INTERVAL_TOKENS: Final[tuple[str, ...]] = ("1d", "1wk")
# urllib's default agent is rejected by the feed often enough to be worth setting.
USER_AGENT: Final[str] = "summa-fetch-benchmark/1.0"
EXPECTED_CURRENCY: Final[str] = "EUR"

EXIT_OK: Final[int] = 0
EXIT_ERROR: Final[int] = 1


class FeedError(Exception):
    """The benchmark feed could not be reached or understood."""


@dataclass(frozen=True)
class BenchmarkPrice:
    """One dated close of the benchmark series."""

    date: str
    close: float


# --- Parsing ----------------------------------------------------------------


def _require_mapping(value: object, what: str) -> Mapping[str, Any]:
    """Narrow a decoded JSON value to an object.

    :raises FeedError: the value is something else.
    """
    if not isinstance(value, dict):
        raise FeedError(f"expected an object for {what}")
    return value


def _require_list(value: object, what: str) -> list[Any]:
    """Narrow a decoded JSON value to an array.

    :raises FeedError: the value is something else.
    """
    if not isinstance(value, list):
        raise FeedError(f"expected a list for {what}")
    return value


def to_iso_date(timestamp: float) -> str:
    """Convert a feed timestamp to an ISO date in UTC.

    A weekly bar is stamped at the start of its week; a local timezone west of
    UTC would move it onto the previous day and shift the whole series.
    """
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).date().isoformat()


def parse_chart_payload(payload: object) -> tuple[str, list[BenchmarkPrice]]:
    """Extract the currency and the ascending closes from a chart response.

    :raises FeedError: the payload reports an error, changed shape or carries no
        usable point.
    """
    chart: Mapping[str, Any] = _require_mapping(
        _require_mapping(payload, "the response").get("chart"), "chart"
    )
    reported_error: Any = chart.get("error")
    if reported_error is not None:
        raise FeedError(f"the feed reported an error: {reported_error}")

    results: list[Any] = _require_list(chart.get("result"), "chart.result")
    if not results:
        raise FeedError("the feed returned no result")
    result: Mapping[str, Any] = _require_mapping(results[0], "chart.result[0]")

    currency: Any = _require_mapping(result.get("meta"), "meta").get("currency")
    if not isinstance(currency, str):
        raise FeedError("the feed named no currency")

    timestamps: list[Any] = _require_list(result.get("timestamp"), "timestamp")
    adjclose: list[Any] = _require_list(
        _require_mapping(result.get("indicators"), "indicators").get("adjclose"),
        "indicators.adjclose",
    )
    if not adjclose:
        raise FeedError("the feed returned no closes")
    closes: list[Any] = _require_list(
        _require_mapping(adjclose[0], "indicators.adjclose[0]").get("adjclose"),
        "indicators.adjclose[0].adjclose",
    )
    if len(closes) != len(timestamps):
        raise FeedError(
            f"the feed returned {len(timestamps)} dates for {len(closes)} closes"
        )

    prices: list[BenchmarkPrice] = []
    for timestamp, close in zip(timestamps, closes):
        # A holiday week is published with a null close rather than omitted.
        if close is None:
            continue
        if not isinstance(timestamp, (int, float)) or not isinstance(
            close, (int, float)
        ):
            raise FeedError("the feed returned a non-numeric point")
        prices.append(
            BenchmarkPrice(
                date=to_iso_date(float(timestamp)),
                close=round(float(close), CLOSE_DIGITS),
            )
        )
    if not prices:
        raise FeedError("the feed returned no usable closes")

    prices.sort(key=lambda price: price.date)
    return currency, prices


# --- Fetching and writing ---------------------------------------------------


def fetch_chart(symbol: str, range_token: str, interval: str, timeout: float) -> object:
    """Fetch a symbol's chart payload and return the decoded JSON.

    No retry here: the compose loop reruns after a non-zero exit.

    :raises FeedError: on any network, HTTP or decoding failure.
    """
    url: str = CHART_URL.format(symbol=quote(symbol, safe=""))
    query: str = urlencode({"interval": interval, "range": range_token})
    request: Request = Request(f"{url}?{query}", headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=timeout) as response:
            raw: bytes = response.read()
    except OSError as error:
        # URLError, HTTPError and socket timeouts are all OSError subclasses.
        raise FeedError(f"could not reach the feed: {error}") from error

    try:
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise FeedError(f"the feed did not return JSON: {error}") from error


def upsert_prices(
    cursor: sqlite3.Cursor, symbol: str, prices: Sequence[BenchmarkPrice]
) -> tuple[int, int]:
    """Write the series, refreshing closes already on record.

    An upsert, not ``INSERT OR IGNORE``: the newest bar is the week in progress
    and its close still moves.

    :return: how many rows were inserted and how many were updated.
    """
    cursor.execute("SELECT date FROM benchmark_prices WHERE symbol = ?", (symbol,))
    known: set[str] = {str(row["date"]) for row in cursor.fetchall()}
    inserted: int = sum(1 for price in prices if price.date not in known)

    cursor.executemany(
        "INSERT INTO benchmark_prices (symbol, date, close) VALUES (?, ?, ?) "
        "ON CONFLICT (symbol, date) DO UPDATE SET close = excluded.close",
        [(symbol, price.date, price.close) for price in prices],
    )
    return inserted, len(prices) - inserted


# --- Command line -----------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        prog="fetch_benchmark",
        description="Refresh the portfolio benchmark series from a public feed.",
        epilog=(
            "Exits non-zero on failure so a caller can retry; the app degrades "
            "to its own fallback position in the meantime."
        ),
    )
    # Read at call time, not import, so the default follows the run's environment.
    configured_symbol: str = config.benchmark_symbol()
    parser.add_argument(
        "--symbol",
        default=configured_symbol,
        help=(
            f"ticker to fetch (default: {configured_symbol}, the EUR-quoted MSCI "
            f"World unless ${config.BENCHMARK_SYMBOL_ENV} says otherwise). The app "
            "charts the configured symbol only, so fetching another one writes "
            "rows nothing reads until that variable names it too"
        ),
    )
    parser.add_argument(
        "--range",
        choices=RANGE_TOKENS,
        default=DEFAULT_RANGE,
        help=f"how much history to request (default: {DEFAULT_RANGE})",
    )
    parser.add_argument(
        "--interval",
        choices=INTERVAL_TOKENS,
        default=DEFAULT_INTERVAL,
        help=f"bar size (default: {DEFAULT_INTERVAL}, matching the snapshot grid)",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=default_database_path(),
        help="database to write to (default: $DATABASE_PATH, else invoices.db)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help=f"request timeout in seconds (default: {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be written without writing it",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Fetch the series, write it and return a process exit code."""
    args: argparse.Namespace = build_parser().parse_args(argv)

    try:
        currency, prices = parse_chart_payload(
            fetch_chart(args.symbol, args.range, args.interval, args.timeout)
        )
    except FeedError as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_ERROR

    if currency != EXPECTED_CURRENCY:
        print(
            f"warning: {args.symbol} is quoted in {currency}, not {EXPECTED_CURRENCY}",
            file=sys.stderr,
        )
    configured_symbol: str = config.benchmark_symbol()
    if args.symbol != configured_symbol:
        print(
            f"note: the chart reads {configured_symbol}, so these {args.symbol} rows "
            f"stay unread until ${config.BENCHMARK_SYMBOL_ENV} names {args.symbol}",
            file=sys.stderr,
        )
    print(
        f"Fetched {args.symbol} ({currency}, {args.interval}, {args.range}): "
        f"{len(prices)} points {prices[0].date}..{prices[-1].date}"
    )
    if args.dry_run:
        print("Dry run — nothing written")
        return EXIT_OK

    try:
        with open_database(args.db, dry_run=False) as cursor:
            inserted, updated = upsert_prices(cursor, args.symbol, prices)
    except sqlite3.Error as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_ERROR

    print(f"Wrote benchmark_prices: {inserted} inserted, {updated} updated")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
