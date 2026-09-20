"""Unit tests for :mod:`scripts.fetch_benchmark`."""

import sqlite3
from typing import Any, Final

import pytest

import scripts.fetch_benchmark as fetch_benchmark
from scripts.fetch_benchmark import (
    BenchmarkPrice,
    FeedError,
    build_parser,
    parse_chart_payload,
    to_iso_date,
    upsert_prices,
)
from summa import config
from summa.db import create_portfolio_schema

SYMBOL: Final[str] = "EUNL.DE"
# 2025-09-14 and 2025-09-21, the Sundays a weekly bar is stamped with.
FIRST_TIMESTAMP: Final[int] = 1757808000
SECOND_TIMESTAMP: Final[int] = 1758412800


def _payload(
    timestamps: list[Any] | None = None,
    closes: list[Any] | None = None,
    currency: str = "EUR",
) -> dict[str, Any]:
    """Build a chart response in the shape the feed returns."""
    return {
        "chart": {
            "error": None,
            "result": [
                {
                    "meta": {"currency": currency, "symbol": SYMBOL},
                    "timestamp": timestamps
                    if timestamps is not None
                    else [FIRST_TIMESTAMP, SECOND_TIMESTAMP],
                    "indicators": {
                        "adjclose": [
                            {
                                "adjclose": closes
                                if closes is not None
                                else [106.965, 107.065]
                            }
                        ]
                    },
                }
            ],
        }
    }


def _memory_database() -> sqlite3.Connection:
    """Return an in-memory database carrying the portfolio schema."""
    conn: sqlite3.Connection = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_portfolio_schema(conn.cursor())
    conn.commit()
    return conn


def test_to_iso_date_reads_a_timestamp_in_utc() -> None:
    """A weekly bar keeps the Sunday it is stamped with, whatever the local zone."""
    assert to_iso_date(FIRST_TIMESTAMP) == "2025-09-14"


def test_parse_chart_payload_reads_the_series() -> None:
    """A well-formed payload yields the currency and ascending closes."""
    currency, prices = parse_chart_payload(_payload())

    assert currency == "EUR"
    assert prices == [
        BenchmarkPrice(date="2025-09-14", close=106.965),
        BenchmarkPrice(date="2025-09-21", close=107.065),
    ]


def test_parse_chart_payload_sorts_by_date() -> None:
    """Points arrive ascending even when the feed lists them out of order."""
    payload: dict[str, Any] = _payload(
        timestamps=[SECOND_TIMESTAMP, FIRST_TIMESTAMP], closes=[107.065, 106.965]
    )
    _, prices = parse_chart_payload(payload)

    assert [price.date for price in prices] == ["2025-09-14", "2025-09-21"]


def test_parse_chart_payload_drops_a_null_close() -> None:
    """A holiday week is published with a null close and is simply left out."""
    _, prices = parse_chart_payload(_payload(closes=[None, 107.065]))

    assert [price.date for price in prices] == ["2025-09-21"]


def test_parse_chart_payload_keeps_a_non_eur_currency() -> None:
    """A foreign quote is reported back, not rejected — the series is rebased anyway."""
    currency, prices = parse_chart_payload(_payload(currency="USD"))

    assert currency == "USD"
    assert len(prices) == 2


@pytest.mark.parametrize(
    ("payload", "match"),
    [
        ("not json at all", "the response"),
        ({"chart": {"error": "Not Found", "result": None}}, "reported an error"),
        ({"chart": {"error": None, "result": []}}, "no result"),
        ({"chart": {"error": None, "result": [{}]}}, "meta"),
    ],
)
def test_parse_chart_payload_rejects_a_broken_payload(payload: Any, match: str) -> None:
    """A payload that is not shaped like a chart raises FeedError, not TypeError."""
    with pytest.raises(FeedError, match=match):
        parse_chart_payload(payload)


def test_parse_chart_payload_rejects_mismatched_lengths() -> None:
    """Dates and closes must line up or the series would silently shift."""
    with pytest.raises(FeedError, match="2 dates for 1 closes"):
        parse_chart_payload(_payload(closes=[106.965]))


def test_parse_chart_payload_rejects_a_series_of_nulls() -> None:
    """A payload whose every close is null carries no series at all."""
    with pytest.raises(FeedError, match="no usable closes"):
        parse_chart_payload(_payload(closes=[None, None]))


def test_parse_chart_payload_rejects_a_non_numeric_close() -> None:
    """A close that is not a number is a broken feed, not a point to guess at."""
    with pytest.raises(FeedError, match="non-numeric"):
        parse_chart_payload(_payload(closes=["106.965", 107.065]))


def test_upsert_prices_inserts_a_new_series() -> None:
    """A first run writes every point."""
    conn: sqlite3.Connection = _memory_database()
    prices: list[BenchmarkPrice] = [
        BenchmarkPrice(date="2025-09-14", close=106.965),
        BenchmarkPrice(date="2025-09-21", close=107.065),
    ]

    assert upsert_prices(conn.cursor(), SYMBOL, prices) == (2, 0)
    assert (
        conn.execute("SELECT COUNT(*) AS n FROM benchmark_prices").fetchone()["n"] == 2
    )


def test_upsert_prices_refreshes_the_week_in_progress() -> None:
    """The newest bar keeps moving, so a re-run updates rather than skips it."""
    conn: sqlite3.Connection = _memory_database()
    cursor: sqlite3.Cursor = conn.cursor()
    upsert_prices(cursor, SYMBOL, [BenchmarkPrice(date="2025-09-21", close=107.065)])

    written: tuple[int, int] = upsert_prices(
        cursor,
        SYMBOL,
        [
            BenchmarkPrice(date="2025-09-21", close=108.5),
            BenchmarkPrice(date="2025-09-28", close=109.0),
        ],
    )

    assert written == (1, 1)
    row: Any = conn.execute(
        "SELECT close FROM benchmark_prices WHERE symbol = ? AND date = ?",
        (SYMBOL, "2025-09-21"),
    ).fetchone()
    assert row["close"] == 108.5


def test_upsert_prices_keeps_symbols_apart() -> None:
    """Two symbols on the same date are two rows, per the composite primary key."""
    conn: sqlite3.Connection = _memory_database()
    cursor: sqlite3.Cursor = conn.cursor()
    upsert_prices(cursor, SYMBOL, [BenchmarkPrice(date="2025-09-21", close=107.065)])

    assert upsert_prices(
        cursor, "URTH", [BenchmarkPrice(date="2025-09-21", close=199.0)]
    ) == (
        1,
        0,
    )
    assert (
        conn.execute("SELECT COUNT(*) AS n FROM benchmark_prices").fetchone()["n"] == 2
    )


# --- Command line -----------------------------------------------------------


def test_symbol_defaults_to_the_symbol_the_chart_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Job and chart resolve the symbol through the same accessor."""
    monkeypatch.setenv(config.BENCHMARK_SYMBOL_ENV, "URTH")

    assert build_parser().parse_args([]).symbol == "URTH"


def test_a_foreign_symbol_is_written_but_reported(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Fetching another ticker is allowed — it just no longer happens silently."""
    monkeypatch.setattr(fetch_benchmark, "fetch_chart", lambda *args: _payload())

    assert fetch_benchmark.main(["--symbol", "SPY", "--dry-run"]) == 0

    errors: str = capsys.readouterr().err
    assert config.DEFAULT_BENCHMARK_SYMBOL in errors
    assert "SPY" in errors
