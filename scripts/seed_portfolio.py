"""Fill the portfolio tables with a plausible depot history, for UI checks.

A workstation tool covering the Portfolio screen's states: depot switcher,
allocation pooling, movers, range filters, foreign currencies, a sale and the
benchmark line. :func:`build_seed_data` is pure and seed-deterministic, so the
tests need no database; only the writer touches SQLite. Weekly returns mix a
per-position drift with a *shared* market factor, so positions move together
and the movers list reads like a market rather than noise.

Re-running keeps every recorded row (``INSERT OR IGNORE``); ``--reset`` clears
the portfolio tables only; ``--dry-run`` works on an in-memory copy.
"""

import argparse
import sqlite3
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from random import Random
from typing import Final

from scripts.portfolio_db import (
    SnapshotWrite,
    default_database_path,
    insert_snapshots,
    open_database,
    resolve_depot,
    resolve_position,
)
from summa import config
from summa.portfolio import AMOUNT_DIGITS, CLOSE_DIGITS, DEFAULT_FX_RATE

DEFAULT_WEEKS: Final[int] = 156
DEFAULT_SEED: Final[int] = 20260921
MIN_WEEKS: Final[int] = 8

# Benchmark weeks before the first snapshot: the chart anchors on the last close
# at or before its first date (``_anchor_value``), which must lie outside the window.
BENCHMARK_PREROLL: Final[int] = 12

MONTHLY: Final[int] = 4
QUARTERLY: Final[int] = 13

# The benchmark tracks the shared market factor with a little noise of its own,
# so the portfolio does not shadow it week for week.
MARKET_DRIFT: Final[float] = 0.0022
MARKET_VOLATILITY: Final[float] = 0.0112
BENCHMARK_START_CLOSE: Final[float] = 78.5
BENCHMARK_VOLATILITY: Final[float] = 0.0022

# FX_BAND bounds a drifting rate, as factors on its starting rate.
CARRY_PROBABILITY: Final[float] = 0.02
FX_VOLATILITY: Final[float] = 0.006
FX_BAND: Final[tuple[float, float]] = (0.92, 1.09)

# The schema allows 0, but a zero grid point makes
# :func:`summa.portfolio.rebase_to_grid` silently drop the benchmark line.
MIN_VALUE: Final[float] = 0.01

EXIT_OK: Final[int] = 0
EXIT_SEED_ERROR: Final[int] = 1
EXIT_USAGE_ERROR: Final[int] = 2


@dataclass(frozen=True)
class SeedDepot:
    """A depot to create."""

    name: str
    sort_order: int


@dataclass(frozen=True)
class SeedSnapshot:
    """One generated week, in the position's own currency."""

    date: str
    value: float
    deposit: float
    fx_rate: float
    carried: bool


@dataclass(frozen=True)
class SeedPosition:
    """A generated position together with its full history.

    :param closed_at: the sale date, or None while held. The zeroing row after a
        sale is not in `snapshots`: :func:`summa.portfolio.with_sale_recorded`
        derives it on read, and storing it too would withdraw the proceeds twice.
    """

    depot: str
    name: str
    kind: str
    currency: str
    sort_order: int
    snapshots: list[SeedSnapshot]
    is_benchmark_fallback: bool = False
    closed_at: str | None = None


@dataclass(frozen=True)
class SeedBenchmarkPrice:
    """One dated close of the generated benchmark series."""

    date: str
    close: float


@dataclass(frozen=True)
class SeedData:
    """Everything one run generates, before any of it is written."""

    depots: list[SeedDepot]
    positions: list[SeedPosition]
    benchmark_symbol: str
    benchmark_prices: list[SeedBenchmarkPrice]


@dataclass(frozen=True)
class SeedSummary:
    """What a run did, for the printed report."""

    depots: int
    depots_created: int
    positions: int
    positions_created: int
    snapshots_written: int
    snapshots_existing: int
    rows_carried: int
    benchmark_written: int
    rows_deleted: int


@dataclass(frozen=True)
class PositionSpec:
    """The recipe one position's random walk is grown from.

    :param start_offset: purchase week after the first grid date; the history
        never starts earlier at 0, which would be a zero first grid point.
    :param close_offset: sale week, counted back from the end when negative, or
        None while held.
    :param drift: weekly return beyond the market share, net of
        :func:`_variance_drag`.
    :param beta: the share of the market return this position takes.
    :param deposit_every: weeks between recurring deposits, or None for only
        `extra_deposits`.
    """

    depot: str
    name: str
    kind: str
    currency: str
    fx_rate: float
    start_offset: int
    initial_deposit: float
    deposit_every: int | None
    deposit_amount: float
    drift: float
    beta: float
    volatility: float
    close_offset: int | None = None
    is_benchmark_fallback: bool = False
    extra_deposits: tuple[tuple[int, float], ...] = field(default_factory=tuple)


DEPOTS: Final[tuple[SeedDepot, ...]] = (
    SeedDepot(name="Trade Republic", sort_order=0),
    SeedDepot(name="Scalable Capital", sort_order=1),
    SeedDepot(name="DKB", sort_order=2),
)

# Ten held plus one sold, so the donut shows five slices and a pooled "5 more".
# Offsets are against DEFAULT_WEEKS; :func:`_resolve_offset` scales them.
POSITION_SPECS: Final[tuple[PositionSpec, ...]] = (
    PositionSpec(
        depot="Trade Republic",
        name="MSCI World UCITS ETF",
        kind="etf",
        currency="EUR",
        fx_rate=1.0,
        start_offset=0,
        initial_deposit=3000.0,
        deposit_every=MONTHLY,
        deposit_amount=250.0,
        drift=0.0002,
        beta=0.95,
        volatility=0.004,
        is_benchmark_fallback=True,
    ),
    PositionSpec(
        depot="Trade Republic",
        name="FTSE All-World High Dividend",
        kind="etf",
        currency="EUR",
        fx_rate=1.0,
        start_offset=20,
        initial_deposit=1200.0,
        deposit_every=MONTHLY,
        deposit_amount=100.0,
        drift=-0.0004,
        beta=0.82,
        volatility=0.006,
    ),
    PositionSpec(
        depot="Trade Republic",
        name="Apple",
        kind="stock",
        currency="USD",
        fx_rate=1.0850,
        start_offset=14,
        initial_deposit=1800.0,
        deposit_every=None,
        deposit_amount=0.0,
        drift=0.0016,
        beta=0.70,
        volatility=0.028,
        extra_deposits=((48, 900.0), (96, 750.0)),
    ),
    PositionSpec(
        depot="Trade Republic",
        name="Nvidia",
        kind="stock",
        currency="USD",
        fx_rate=1.0850,
        start_offset=40,
        initial_deposit=1400.0,
        deposit_every=None,
        deposit_amount=0.0,
        drift=0.0075,
        beta=1.35,
        volatility=0.046,
        extra_deposits=((78, 600.0),),
    ),
    PositionSpec(
        depot="Trade Republic",
        name="Rheinmetall",
        kind="stock",
        currency="EUR",
        fx_rate=1.0,
        start_offset=55,
        initial_deposit=1100.0,
        deposit_every=None,
        deposit_amount=0.0,
        drift=0.0060,
        beta=0.45,
        volatility=0.038,
    ),
    PositionSpec(
        depot="Scalable Capital",
        name="STOXX Europe 600 UCITS ETF",
        kind="etf",
        currency="EUR",
        fx_rate=1.0,
        start_offset=2,
        initial_deposit=2200.0,
        deposit_every=MONTHLY,
        deposit_amount=150.0,
        drift=-0.0003,
        beta=0.88,
        volatility=0.005,
    ),
    PositionSpec(
        depot="Scalable Capital",
        name="MSCI Emerging Markets IMI",
        kind="etf",
        currency="EUR",
        fx_rate=1.0,
        start_offset=28,
        initial_deposit=800.0,
        deposit_every=MONTHLY,
        deposit_amount=75.0,
        drift=-0.0018,
        beta=0.75,
        volatility=0.009,
    ),
    PositionSpec(
        depot="Scalable Capital",
        name="Novo Nordisk",
        kind="stock",
        currency="DKK",
        fx_rate=7.4580,
        start_offset=33,
        initial_deposit=9500.0,
        deposit_every=None,
        deposit_amount=0.0,
        drift=0.0018,
        beta=0.55,
        volatility=0.031,
        extra_deposits=((88, 4200.0),),
    ),
    PositionSpec(
        depot="Scalable Capital",
        name="Bayer",
        kind="stock",
        currency="EUR",
        fx_rate=1.0,
        start_offset=8,
        initial_deposit=2400.0,
        deposit_every=None,
        deposit_amount=0.0,
        drift=-0.0062,
        beta=0.60,
        volatility=0.030,
        extra_deposits=((70, 800.0),),
    ),
    PositionSpec(
        depot="DKB",
        name="Deka Global Champions",
        kind="fund",
        currency="EUR",
        fx_rate=1.0,
        start_offset=5,
        initial_deposit=1600.0,
        deposit_every=QUARTERLY,
        deposit_amount=500.0,
        drift=-0.0006,
        beta=0.80,
        volatility=0.007,
    ),
    PositionSpec(
        depot="DKB",
        name="Zalando",
        kind="stock",
        currency="EUR",
        fx_rate=1.0,
        start_offset=6,
        initial_deposit=1900.0,
        deposit_every=None,
        deposit_amount=0.0,
        drift=0.0005,
        beta=0.65,
        volatility=0.024,
        close_offset=-20,
    ),
)


# --- Pure generation --------------------------------------------------------


def weekly_grid(weeks: int, today: date) -> list[str]:
    """Return `weeks` consecutive Mondays ending on the most recent one.

    Never past `today`: writing straight to SQLite bypasses the API's check
    against future-dated snapshots.
    """
    last_monday: date = today - timedelta(days=today.weekday())
    first: date = last_monday - timedelta(weeks=weeks - 1)
    return [(first + timedelta(weeks=step)).isoformat() for step in range(weeks)]


def _resolve_offset(offset: int, weeks: int) -> int:
    """Map a spec offset onto a grid of `weeks` weeks.

    Scaled rather than clipped, so a short run keeps its late entries; a
    negative offset counts back from the final week, keeping the sale a fixed
    distance from today.
    """
    scaled: int = round(offset * weeks / DEFAULT_WEEKS)
    if offset < 0:
        return max(1, weeks - 1 + scaled)
    return min(scaled, weeks - 2)


def _market_returns(rng: Random, length: int) -> list[float]:
    """Draw the weekly market return every position shares."""
    return [rng.gauss(MARKET_DRIFT, MARKET_VOLATILITY) for _ in range(length)]


def _variance_drag(spec: PositionSpec) -> float:
    """Return the weekly growth a position's volatility costs it: half the variance.

    Subtracting it makes ``drift`` mean the same expected growth for a calm ETF
    and a volatile single stock.
    """
    variance: float = (spec.beta * MARKET_VOLATILITY) ** 2 + spec.volatility**2
    return variance / 2


def _fx_series(rng: Random, base_rate: float, length: int) -> list[float]:
    """Draw a slowly drifting weekly FX rate, clamped to `FX_BAND` around the base."""
    if base_rate == DEFAULT_FX_RATE:
        return [DEFAULT_FX_RATE] * length

    low: float = base_rate * FX_BAND[0]
    high: float = base_rate * FX_BAND[1]
    rates: list[float] = []
    rate: float = base_rate
    for _ in range(length):
        rate = min(max(rate * (1 + rng.gauss(0.0, FX_VOLATILITY)), low), high)
        rates.append(round(rate, 4))
    return rates


def _deposit_for(
    spec: PositionSpec, week: int, start: int, extras: dict[int, float]
) -> float:
    """Return the money paid into a position in one week, 0 when none was.

    :param start: the grid index the position was bought in.
    """
    if week == start:
        return spec.initial_deposit
    extra: float = extras.get(week, 0.0)
    if spec.deposit_every is not None and (week - start) % spec.deposit_every == 0:
        return spec.deposit_amount + extra
    return extra


def _build_snapshots(
    spec: PositionSpec,
    grid: Sequence[str],
    market: Sequence[float],
    weeks: int,
    rng: Random,
) -> tuple[list[SeedSnapshot], str | None]:
    """Grow one position's weekly history, and the date it was sold on.

    Only a week without a deposit can be carried: money that moved is a week
    somebody recorded.

    :return: the snapshots, ascending by date, and ``closed_at`` or None.
    """
    start: int = _resolve_offset(spec.start_offset, weeks)
    last: int = weeks - 1
    closed_at: str | None = None
    if spec.close_offset is not None:
        last = max(_resolve_offset(spec.close_offset, weeks), start + 1)
        closed_at = grid[last]

    extras: dict[int, float] = {
        _resolve_offset(offset, weeks): amount for offset, amount in spec.extra_deposits
    }
    rates: list[float] = _fx_series(rng, spec.fx_rate, weeks)
    drag: float = _variance_drag(spec)

    snapshots: list[SeedSnapshot] = []
    value: float = 0.0
    for week in range(start, last + 1):
        deposit: float = _deposit_for(spec, week, start, extras)
        carried: bool = False
        if week == start:
            value = spec.initial_deposit
        elif deposit == 0 and rng.random() < CARRY_PROBABILITY:
            carried = True
        else:
            weekly_return: float = (
                spec.drift
                + spec.beta * market[week]
                + rng.gauss(0.0, spec.volatility)
                - drag
            )
            value = max(value * (1 + weekly_return) + deposit, MIN_VALUE)
        snapshots.append(
            SeedSnapshot(
                date=grid[week],
                value=round(value, AMOUNT_DIGITS),
                deposit=round(deposit, AMOUNT_DIGITS),
                fx_rate=rates[week],
                carried=carried,
            )
        )
    return snapshots, closed_at


def _build_benchmark(
    rng: Random,
    dates: Sequence[str],
    preroll: Sequence[float],
    market: Sequence[float],
) -> list[SeedBenchmarkPrice]:
    """Grow the benchmark series over the pre-roll and the snapshot grid.

    :param dates: the pre-roll dates followed by the snapshot grid, ascending.
    """
    returns: list[float] = list(preroll) + list(market)
    # The positions' drag correction too, so both lines' drifts mean the same.
    drag: float = (MARKET_VOLATILITY**2 + BENCHMARK_VOLATILITY**2) / 2
    prices: list[SeedBenchmarkPrice] = []
    close: float = BENCHMARK_START_CLOSE
    for index, point_date in enumerate(dates):
        if index > 0:
            close *= 1 + returns[index] + rng.gauss(0.0, BENCHMARK_VOLATILITY) - drag
        prices.append(
            SeedBenchmarkPrice(date=point_date, close=round(close, CLOSE_DIGITS))
        )
    return prices


def build_seed_data(
    weeks: int, seed: int, today: date, benchmark_symbol: str
) -> SeedData:
    """Generate the whole fake portfolio, deterministically for a given seed.

    No clock, environment or database is read, so a screenshot is reproducible
    and the invariants are testable without SQLite.
    """
    rng: Random = Random(seed)
    grid: list[str] = weekly_grid(weeks, today)
    preroll_dates: list[str] = weekly_grid(BENCHMARK_PREROLL + weeks, today)[
        :BENCHMARK_PREROLL
    ]
    preroll_returns: list[float] = _market_returns(rng, BENCHMARK_PREROLL)
    market: list[float] = _market_returns(rng, weeks)

    positions: list[SeedPosition] = []
    order_per_depot: dict[str, int] = {}
    for spec in POSITION_SPECS:
        snapshots, closed_at = _build_snapshots(spec, grid, market, weeks, rng)
        sort_order: int = order_per_depot.get(spec.depot, 0)
        order_per_depot[spec.depot] = sort_order + 1
        positions.append(
            SeedPosition(
                depot=spec.depot,
                name=spec.name,
                kind=spec.kind,
                currency=spec.currency,
                sort_order=sort_order,
                snapshots=snapshots,
                is_benchmark_fallback=spec.is_benchmark_fallback,
                closed_at=closed_at,
            )
        )

    return SeedData(
        depots=list(DEPOTS),
        positions=positions,
        benchmark_symbol=benchmark_symbol,
        benchmark_prices=_build_benchmark(
            rng, preroll_dates + grid, preroll_returns, market
        ),
    )


def snapshot_range(positions: Sequence[SeedPosition]) -> tuple[str, str]:
    """Return the first and last week any position was recorded in.

    Taken across all positions: the first spec need not start at week 0, and a
    sold position ends before the grid does.

    :param positions: at least one position, each with at least one snapshot.
    """
    first: str = min(position.snapshots[0].date for position in positions)
    last: str = max(position.snapshots[-1].date for position in positions)
    return first, last


def symbol_notes(symbol: str, configured: str, reset: bool, dry_run: bool) -> list[str]:
    """Return the stderr notes owed for seeding a symbol the chart does not read.

    With ``--reset`` the configured symbol's closes are cleared as well, leaving
    the chart with no benchmark at all.
    """
    if symbol == configured:
        return []

    notes: list[str] = [
        f"note: the chart reads {configured}, so these {symbol} rows stay unread "
        f"until ${config.BENCHMARK_SYMBOL_ENV} names {symbol}"
    ]
    if reset:
        verb: str = "would clear" if dry_run else "clears"
        notes.append(
            f"note: --reset {verb} every {configured} close as well, leaving the "
            "chart without a benchmark line until it is fetched again"
        )
    return notes


def format_summary(summary: SeedSummary) -> str:
    """Render the seed summary as an indented block."""
    lines: list[str] = [
        f"  depots     {summary.depots:5d}  ({summary.depots_created} created)",
        f"  positions  {summary.positions:5d}  ({summary.positions_created} created)",
        f"  snapshots  {summary.snapshots_written:5d} written, {summary.snapshots_existing} already present",
        f"  carried    {summary.rows_carried:5d}  of them copied forward",
        f"  benchmark  {summary.benchmark_written:5d}  closes upserted",
    ]
    if summary.rows_deleted:
        lines.insert(0, f"  cleared    {summary.rows_deleted:5d}  portfolio rows")
    return "\n".join(lines)


# --- Writing ----------------------------------------------------------------

PORTFOLIO_TABLES: Final[tuple[str, ...]] = (
    "portfolio_snapshots",
    "portfolio_positions",
    "portfolio_depots",
    "benchmark_prices",
)


def clear_portfolio(cursor: sqlite3.Cursor) -> int:
    """Delete every portfolio row, leaving the invoice tables alone.

    Positions and snapshots follow their depot via ``ON DELETE CASCADE``.

    :return: how many rows were deleted, across all four tables.
    """
    deleted: int = 0
    for table in PORTFOLIO_TABLES:
        row: sqlite3.Row = cursor.execute(
            f"SELECT COUNT(*) AS n FROM {table}"
        ).fetchone()
        deleted += int(row["n"])
    cursor.execute("DELETE FROM portfolio_depots")
    cursor.execute("DELETE FROM benchmark_prices")
    return deleted


def upsert_benchmark(
    cursor: sqlite3.Cursor, symbol: str, prices: Sequence[SeedBenchmarkPrice]
) -> int:
    """Write the generated closes, refreshing any already on record.

    An upsert like ``fetch_benchmark``'s, so re-seeding with another seed moves
    the line instead of leaving the previous closes beside it.

    :return: how many closes were written.
    """
    cursor.executemany(
        "INSERT INTO benchmark_prices (symbol, date, close) VALUES (?, ?, ?) "
        "ON CONFLICT (symbol, date) DO UPDATE SET close = excluded.close",
        [(symbol, price.date, price.close) for price in prices],
    )
    return len(prices)


def write_seed_data(cursor: sqlite3.Cursor, data: SeedData, reset: bool) -> SeedSummary:
    """Write depots, positions, snapshots and the benchmark, and report what happened."""
    deleted: int = clear_portfolio(cursor) if reset else 0

    depot_ids: dict[str, int] = {}
    depots_created: int = 0
    for depot in data.depots:
        depot_id, depot_is_new = resolve_depot(cursor, depot.name, depot.sort_order)
        depot_ids[depot.name] = depot_id
        depots_created += int(depot_is_new)

    positions_created: int = 0
    written: int = 0
    existing: int = 0
    carried: int = 0
    for position in data.positions:
        position_id, position_is_new = resolve_position(
            cursor,
            depot_ids[position.depot],
            position.name,
            position.kind,
            position.currency,
            position.sort_order,
            is_benchmark_fallback=position.is_benchmark_fallback,
            closed_at=position.closed_at,
        )
        positions_created += int(position_is_new)
        result: SnapshotWrite = insert_snapshots(
            cursor, position_id, position.snapshots
        )
        written += result.written
        existing += result.existing
        carried += result.carried

    return SeedSummary(
        depots=len(data.depots),
        depots_created=depots_created,
        positions=len(data.positions),
        positions_created=positions_created,
        snapshots_written=written,
        snapshots_existing=existing,
        rows_carried=carried,
        benchmark_written=upsert_benchmark(
            cursor, data.benchmark_symbol, data.benchmark_prices
        ),
        rows_deleted=deleted,
    )


def seed_database(
    data: SeedData, database_path: Path, reset: bool, dry_run: bool
) -> SeedSummary:
    """Open the database and write the generated data to it."""
    with open_database(database_path, dry_run) as cursor:
        return write_seed_data(cursor, data, reset)


# --- Command line -----------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        prog="seed_portfolio",
        description="Fill the portfolio tables with a plausible depot history.",
        epilog=(
            "A workstation tool for looking at the Portfolio screen, not part of "
            "the served app. Without --reset a week already recorded is kept as "
            "it is, so a value corrected in the UI survives a re-run."
        ),
    )
    # Read at call time, not import, so the default follows the run's environment.
    configured_symbol: str = config.benchmark_symbol()
    parser.add_argument(
        "--db",
        type=Path,
        default=default_database_path(),
        help="database to write to (default: $DATABASE_PATH, else invoices.db)",
    )
    parser.add_argument(
        "--weeks",
        type=int,
        default=DEFAULT_WEEKS,
        help=f"weeks of history to generate (default: {DEFAULT_WEEKS}, about three years)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=(
            f"random seed (default: {DEFAULT_SEED}); the same seed and --weeks "
            "always yield the same history"
        ),
    )
    parser.add_argument(
        "--symbol",
        default=configured_symbol,
        help=(
            f"symbol to write the benchmark closes under (default: {configured_symbol}). "
            f"The chart draws the symbol ${config.BENCHMARK_SYMBOL_ENV} names, so another "
            "one writes rows nothing reads"
        ),
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="clear the portfolio tables first; the invoice tables are never touched",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be written without writing it",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Generate the data, write it and return a process exit code."""
    args: argparse.Namespace = build_parser().parse_args(argv)
    if args.weeks < MIN_WEEKS:
        print(f"error: --weeks needs at least {MIN_WEEKS}", file=sys.stderr)
        return EXIT_USAGE_ERROR

    # Re-read, not the parser default, in case the environment changed since.
    for note in symbol_notes(
        args.symbol, config.benchmark_symbol(), args.reset, args.dry_run
    ):
        print(note, file=sys.stderr)

    data: SeedData = build_seed_data(args.weeks, args.seed, date.today(), args.symbol)
    try:
        summary: SeedSummary = seed_database(
            data, args.db, reset=args.reset, dry_run=args.dry_run
        )
    except (OSError, sqlite3.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_SEED_ERROR

    headline: str = "Dry run — nothing written" if args.dry_run else "Seeded"
    first_date, last_date = snapshot_range(data.positions)
    print(
        f"{headline}: {first_date}..{last_date} ({args.weeks} weeks, seed {args.seed}) "
        f"-> {args.db}"
    )
    print(format_summary(summary))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
