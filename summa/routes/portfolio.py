"""REST API routes that read the portfolio area: overview, snapshot prefill and history.

Maps SQLite rows into :mod:`summa.portfolio` and serialises the result; no
arithmetic here beyond rounding at the JSON boundary.
"""

import logging
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Final

from flask import Blueprint, Response, jsonify, request

from summa import config, portfolio
from summa.db import chunked, db_cursor, placeholders_for
from summa.helpers import ApiResponse, ValidationError, error_response
from summa.portfolio import AMOUNT_DIGITS

logger: logging.Logger = logging.getLogger(__name__)

portfolio_bp: Blueprint = Blueprint("portfolio", __name__)

# Explicit token, so ?depot=all is intended rather than an int() failure.
DEPOT_ALL: Final[str] = "all"
SNAPSHOT_INTERVAL_DAYS: Final[int] = 7
PERCENT_DIGITS: Final[int] = 1


# --- Rounding ---------------------------------------------------------------
# The only place that rounds: rounding twice breaks subtotals against their rows.


def _amount(value: float) -> float:
    """Round a EUR amount for the JSON boundary."""
    return round(value, AMOUNT_DIGITS)


def _optional_amount(value: float | None) -> float | None:
    """Round a EUR amount, keeping None as None — undefined is not zero."""
    return None if value is None else round(value, AMOUNT_DIGITS)


def _percent(value: float) -> float:
    """Round a percentage for the JSON boundary."""
    return round(value, PERCENT_DIGITS)


def _optional_percent(value: float | None) -> float | None:
    """Round a percentage, keeping None as None."""
    return None if value is None else round(value, PERCENT_DIGITS)


# --- Loading rows into the derivation layer's dataclasses -------------------


def _load_depots(cursor: sqlite3.Cursor, depot_id: int | None) -> list[portfolio.Depot]:
    """Load every depot, or only the requested one."""
    if depot_id is None:
        cursor.execute("SELECT id, name, sort_order FROM portfolio_depots")
    else:
        cursor.execute(
            "SELECT id, name, sort_order FROM portfolio_depots WHERE id = ?",
            (depot_id,),
        )
    return [
        portfolio.Depot(id=row["id"], name=row["name"], sort_order=row["sort_order"])
        for row in cursor.fetchall()
    ]


def _load_snapshots(
    cursor: sqlite3.Cursor, position_ids: Sequence[int]
) -> dict[int, list[portfolio.Snapshot]]:
    """Load every snapshot of the given positions, grouped by position.

    ``ORDER BY date`` provides the ascending order :mod:`summa.portfolio`
    requires; a position's rows always land in a single chunk.
    """
    history: dict[int, list[portfolio.Snapshot]] = {
        position_id: [] for position_id in position_ids
    }
    for chunk in chunked(list(position_ids)):
        cursor.execute(
            "SELECT position_id, date, value, deposit, fx_rate, carried "
            f"FROM portfolio_snapshots WHERE position_id IN ({placeholders_for(len(chunk))}) "
            "ORDER BY position_id, date",
            chunk,
        )
        for row in cursor.fetchall():
            history[row["position_id"]].append(
                portfolio.Snapshot(
                    date=row["date"],
                    value=row["value"],
                    deposit=row["deposit"],
                    fx_rate=row["fx_rate"],
                    carried=bool(row["carried"]),
                )
            )
    return history


def _load_positions(
    cursor: sqlite3.Cursor, depot_ids: Sequence[int]
) -> list[portfolio.Position]:
    """Load the positions of the given depots together with their full history."""
    if not depot_ids:
        return []

    rows: list[Any] = []
    for chunk in chunked(list(depot_ids)):
        cursor.execute(
            "SELECT id, depot_id, name, kind, currency, is_benchmark_fallback, "
            "closed_at, sort_order FROM portfolio_positions "
            f"WHERE depot_id IN ({placeholders_for(len(chunk))})",
            chunk,
        )
        rows.extend(cursor.fetchall())
    if not rows:
        return []

    # The order is global across depots, so it cannot come from a per-chunk ORDER BY.
    rows.sort(key=lambda row: (row["sort_order"], row["name"]))

    position_ids: list[int] = [row["id"] for row in rows]
    history: dict[int, list[portfolio.Snapshot]] = _load_snapshots(cursor, position_ids)
    return [
        portfolio.Position(
            id=row["id"],
            depot_id=row["depot_id"],
            name=row["name"],
            kind=row["kind"],
            currency=row["currency"],
            # Derived, never stored, so closing never overwrites the week sold in.
            snapshots=portfolio.with_sale_recorded(
                history[row["id"]], row["closed_at"]
            ),
            is_benchmark_fallback=bool(row["is_benchmark_fallback"]),
            closed_at=row["closed_at"],
            sort_order=row["sort_order"],
        )
        for row in rows
    ]


# --- Benchmark --------------------------------------------------------------


@dataclass(frozen=True)
class _Benchmark:
    """The benchmark line plus where it came from.

    ``name`` is the feed symbol or the fallback position's name; wording is the
    frontend's business.
    """

    values: list[float]
    source: str | None
    updated_at: str | None
    name: str | None


@dataclass(frozen=True)
class _Feed:
    """The benchmark feed's closes inside the window, with the symbol they came from."""

    points: list[tuple[str, float]]
    updated_at: str | None
    symbol: str | None


def _feed_symbol(cursor: sqlite3.Cursor) -> tuple[str, str] | None:
    """Return the benchmark symbol on record and its newest close date.

    The configured symbol (:func:`summa.config.benchmark_symbol`) wins whenever it
    has any row; only when it has none does the freshest symbol stand in. The
    Settings "Benchmark" select governs only the fallback position, not this.
    """
    configured: str = config.benchmark_symbol()
    cursor.execute(
        "SELECT MAX(date) AS latest FROM benchmark_prices WHERE symbol = ?",
        (configured,),
    )
    row: Any = cursor.fetchone()
    if row is not None and row["latest"] is not None:
        return configured, str(row["latest"])

    cursor.execute(
        "SELECT symbol, MAX(date) AS latest FROM benchmark_prices "
        "GROUP BY symbol ORDER BY latest DESC LIMIT 1"
    )
    row = cursor.fetchone()
    if row is None:
        return None
    return str(row["symbol"]), str(row["latest"])


def _feed_points(cursor: sqlite3.Cursor, start: str | None) -> _Feed:
    """Return the benchmark symbol's closes inside the window, its last date and itself.

    No points (also for history ending before the window) means the chart falls
    back to the flagged position.
    """
    found: tuple[str, str] | None = _feed_symbol(cursor)
    if found is None:
        return _Feed(points=[], updated_at=None, symbol=None)

    symbol, updated_at = found
    if start is None:
        cursor.execute(
            "SELECT date, close FROM benchmark_prices WHERE symbol = ? ORDER BY date",
            (symbol,),
        )
    else:
        cursor.execute(
            "SELECT date, close FROM benchmark_prices "
            "WHERE symbol = ? AND date >= ? ORDER BY date",
            (symbol, start),
        )
    points: list[tuple[str, float]] = [
        (price["date"], price["close"]) for price in cursor.fetchall()
    ]
    return _Feed(points=points, updated_at=updated_at, symbol=symbol)


def _fallback_points(
    cursor: sqlite3.Cursor, start: str | None
) -> tuple[list[tuple[str, float]], str | None]:
    """Return the deposit-free growth of the position flagged as benchmark fallback, and its name.

    Ignores the depot filter on purpose: the benchmark is the chart's yardstick,
    not part of the selection. At most one position carries the flag — the write
    routes clear it on every other position whenever one is set
    (_clear_other_fallbacks in portfolio_writes.py) — so LIMIT 1 is the whole set.
    """
    cursor.execute(
        "SELECT id, name FROM portfolio_positions WHERE is_benchmark_fallback = 1 LIMIT 1"
    )
    row: Any = cursor.fetchone()
    if row is None:
        return [], None

    snapshots: list[portfolio.Snapshot] = _load_snapshots(cursor, [row["id"]])[
        row["id"]
    ]
    # Growth over the full history, then cut: the window's first return is still
    # measured against the week before it.
    points: list[tuple[str, float]] = []
    for point in portfolio.growth_points(snapshots):
        if start is None or point[0] >= start:
            points.append(point)
    return points, str(row["name"])


def _series_base(values: Sequence[float]) -> float:
    """Return the first non-zero value of a series — what the benchmark indexes to."""
    for value in values:
        if value != 0:
            return value
    return 0.0


def _build_benchmark(
    cursor: sqlite3.Cursor,
    grid: Sequence[str],
    base: float,
    start: str | None,
) -> _Benchmark:
    """Build the benchmark line, falling back to the flagged position silently.

    A missing or stale feed is never an error: at worst there is no third line.
    """
    feed: _Feed = _feed_points(cursor, start)
    points: list[tuple[str, float]] = feed.points
    updated_at: str | None = feed.updated_at
    name: str | None = feed.symbol
    source: str | None = "feed"
    if not points:
        points, name = _fallback_points(cursor, start)
        source = "fallback"
        updated_at = points[-1][0] if points else None

    values: list[float] = portfolio.rebase_to_grid(points, grid, base)
    if not values:
        return _Benchmark(values=[], source=None, updated_at=None, name=None)
    return _Benchmark(values=values, source=source, updated_at=updated_at, name=name)


# --- Serialization ----------------------------------------------------------


def _serialize_position(view: portfolio.PositionView) -> dict[str, Any]:
    """Render one position row. gain_pct and week_delta stay null when undefined."""
    return {
        "id": view.id,
        "depot_id": view.depot_id,
        "name": view.name,
        "kind": view.kind,
        "currency": view.currency,
        "is_benchmark_fallback": view.is_benchmark_fallback,
        "closed_at": view.closed_at,
        "value": _amount(view.value),
        "fx_rate": view.fx_rate,
        "value_eur": _amount(view.value_eur),
        "invested_eur": _amount(view.invested_eur),
        "contributed_eur": _amount(view.contributed_eur),
        "gain": _amount(view.gain),
        "gain_pct": _optional_percent(view.gain_pct),
        "week_delta": _optional_amount(view.week_delta),
        "first_snapshot_date": view.first_snapshot_date,
        "last_snapshot_date": view.last_snapshot_date,
        "snapshot_count": view.snapshot_count,
    }


def _serialize_depot(view: portfolio.DepotView) -> dict[str, Any]:
    """Render one depot group with its subtotal."""
    return {
        "id": view.id,
        "name": view.name,
        "positions": [_serialize_position(member) for member in view.positions],
        "value_eur": _amount(view.value_eur),
        "invested_eur": _amount(view.invested_eur),
        "contributed_eur": _amount(view.contributed_eur),
        "gain": _amount(view.gain),
        "gain_pct": _optional_percent(view.gain_pct),
    }


def _serialize_depot_option(depot: portfolio.Depot) -> dict[str, Any]:
    """Render one entry of the depot switcher."""
    return {"id": depot.id, "name": depot.name}


def _serialize_totals(totals: portfolio.PortfolioTotals) -> dict[str, Any]:
    """Render the grand total behind the three summary cards."""
    return {
        "value_eur": _amount(totals.value_eur),
        "invested_eur": _amount(totals.invested_eur),
        "contributed_eur": _amount(totals.contributed_eur),
        "gain": _amount(totals.gain),
        "gain_pct": _optional_percent(totals.gain_pct),
        "week_delta": _amount(totals.week_delta),
        "position_count": totals.position_count,
        "depot_count": totals.depot_count,
        "last_snapshot_date": totals.last_snapshot_date,
    }


def _serialize_slice(allocation_slice: portfolio.AllocationSlice) -> dict[str, Any]:
    """Render one donut slice."""
    return {
        "label": allocation_slice.label,
        "value_eur": _amount(allocation_slice.value_eur),
        "share_pct": _percent(allocation_slice.share_pct),
        "aggregated_count": allocation_slice.aggregated_count,
    }


def _serialize_change(change: portfolio.Change) -> dict[str, Any]:
    """Render one entry of the biggest-changes lists."""
    return {
        "position_id": change.position_id,
        "name": change.name,
        "week_delta": _amount(change.week_delta),
    }


def _serialize_history_row(row: portfolio.HistoryRow) -> dict[str, Any]:
    """Render one week of a position's history. change stays null when undefined."""
    return {
        "date": row.date,
        "value": _amount(row.value),
        "deposit": _amount(row.deposit),
        "fx_rate": row.fx_rate,
        "carried": row.carried,
        "derived": row.derived,
        "value_eur": _amount(row.value_eur),
        "deposit_eur": _amount(row.deposit_eur),
        "change": _optional_amount(row.change),
    }


def _serialize_position_series(entry: portfolio.PositionSeries) -> dict[str, Any]:
    """Render one position's chart line."""
    return {
        "id": entry.position_id,
        "name": entry.name,
        "values": [_amount(value) for value in entry.values],
    }


# --- Query parameters -------------------------------------------------------


def _requested_range() -> str:
    """Return the requested period token, falling back to the default.

    Degrades rather than 400-ing so a stale client value cannot blank the screen;
    the response echoes the token used.
    """
    token: str = request.args.get("range", portfolio.DEFAULT_RANGE)
    if token in portfolio.RANGE_TOKENS:
        return token
    return portfolio.DEFAULT_RANGE


def _requested_depot() -> int | None:
    """Return the requested depot id, or None for all depots.

    A malformed value is rejected: silently widening to all depots would answer
    a question the client did not ask.
    """
    raw: str = request.args.get("depot", "")
    if not raw or raw == DEPOT_ALL:
        return None
    try:
        return int(raw)
    except ValueError:
        raise ValidationError(
            f"Query parameter 'depot' must be a depot id or '{DEPOT_ALL}'",
            field="depot",
        ) from None


# --- Routes -----------------------------------------------------------------


@portfolio_bp.route("/api/portfolio", methods=["GET"])
def get_portfolio() -> ApiResponse:
    """Return the whole Portfolio screen: groups, totals, allocation, series.

    The depot filter narrows everything except ``depot_options``, the switcher's
    own list. The period token affects only the chart.
    """
    range_token: str = _requested_range()

    try:
        depot_id: int | None = _requested_depot()

        with db_cursor() as cursor:
            depots: list[portfolio.Depot] = _load_depots(cursor, depot_id)
            # An id that matches no depot is a client bug, not an empty portfolio.
            if depot_id is not None and not depots:
                raise ValidationError("Depot not found", field="depot")
            every_depot: list[portfolio.Depot] = (
                depots if depot_id is None else _load_depots(cursor, None)
            )
            positions: list[portfolio.Position] = _load_positions(
                cursor, [depot.id for depot in depots]
            )

            views: list[portfolio.PositionView] = [
                portfolio.build_position_view(position) for position in positions
            ]
            # Read once: two calls could straddle midnight.
            today: date = date.today()
            start: date | None = portfolio.range_start(range_token, today)
            grid: list[str] = portfolio.snapshot_dates(positions, start)
            series: portfolio.ChartSeries = portfolio.build_series(positions, grid)
            window: portfolio.ChartWindow = portfolio.chart_window(
                range_token, today, grid
            )
            benchmark: _Benchmark = _build_benchmark(
                cursor,
                grid,
                _series_base(series.portfolio),
                start.isoformat() if start is not None else None,
            )
    except ValidationError as e:
        return error_response(e.message, 400)

    depot_views: list[portfolio.DepotView] = portfolio.build_depot_views(depots, views)
    totals: portfolio.PortfolioTotals = portfolio.build_totals(views, len(depots))
    gainers, losers = portfolio.biggest_changes(views)

    return jsonify(
        {
            "range": range_token,
            "range_start": window.start,
            "range_end": window.end,
            "depot": depot_id,
            "depots": [_serialize_depot(view) for view in depot_views],
            "depot_options": [
                _serialize_depot_option(depot)
                for depot in sorted(every_depot, key=portfolio.by_depot_order)
            ],
            "totals": _serialize_totals(totals),
            "allocation": [
                _serialize_slice(entry) for entry in portfolio.allocation(views)
            ],
            "changes": {
                "gainers": [_serialize_change(change) for change in gainers],
                "losers": [_serialize_change(change) for change in losers],
            },
            "series": {
                "dates": series.dates,
                "portfolio": [_amount(value) for value in series.portfolio],
                "invested": [_amount(value) for value in series.invested],
                "benchmark": [_amount(value) for value in benchmark.values],
                # Always sent, so the chart's position filter needs no round trip.
                "positions": [
                    _serialize_position_series(entry) for entry in series.positions
                ],
            },
            "benchmark_source": benchmark.source,
            "benchmark_updated_at": benchmark.updated_at,
            "benchmark_name": benchmark.name,
        }
    )


def _suggested_snapshot_date(last_snapshot_date: str | None) -> str:
    """Return the next un-snapshotted week, or today when there is no history."""
    if last_snapshot_date is None:
        return date.today().isoformat()
    last: date = date.fromisoformat(last_snapshot_date)
    return (last + timedelta(days=SNAPSHOT_INTERVAL_DAYS)).isoformat()


def _prefill_position(position: portfolio.Position) -> dict[str, Any]:
    """Render one position for the weekly entry form, with its previous reading.

    `previous_carried` lets the form warn that the previous value was copied
    forward; False (not None) without history, as there is nothing to warn about.
    """
    previous: portfolio.Snapshot | None = (
        position.snapshots[-1] if position.snapshots else None
    )
    return {
        "id": position.id,
        "name": position.name,
        "kind": position.kind,
        "currency": position.currency,
        "previous_value": None if previous is None else _amount(previous.value),
        "previous_fx_rate": None if previous is None else previous.fx_rate,
        "previous_date": None if previous is None else previous.date,
        "previous_carried": False if previous is None else previous.carried,
    }


@portfolio_bp.route("/api/portfolio/snapshot/new", methods=["GET"])
def get_snapshot_prefill() -> Response:
    """Return the prefill for the weekly snapshot form: active positions per depot."""
    with db_cursor() as cursor:
        depots: list[portfolio.Depot] = _load_depots(cursor, None)
        positions: list[portfolio.Position] = _load_positions(
            cursor, [depot.id for depot in depots]
        )

    # Sold positions cannot be written by the form, so their dates stay out too.
    active: list[portfolio.Position] = [
        position for position in positions if position.closed_at is None
    ]

    grouped: dict[int, list[dict[str, Any]]] = {depot.id: [] for depot in depots}
    for position in active:
        grouped[position.depot_id].append(_prefill_position(position))

    # All dates, not just the newest: the form warns on any backdated overwrite.
    dates: list[str] = portfolio.snapshot_dates(active, None)
    last_snapshot_date: str | None = dates[-1] if dates else None

    return jsonify(
        {
            "suggested_date": _suggested_snapshot_date(last_snapshot_date),
            "last_snapshot_date": last_snapshot_date,
            "snapshot_dates": dates,
            "depots": [
                {"id": depot.id, "name": depot.name, "positions": grouped[depot.id]}
                for depot in depots
            ],
        }
    )


@portfolio_bp.route(
    "/api/portfolio/positions/<int:position_id>/snapshots", methods=["GET"]
)
def get_position_history(position_id: int) -> ApiResponse:
    """Return one position's weeks, newest first, including a derived closing row.

    Reversed only after the derivation, which requires ascending order.
    """
    with db_cursor() as cursor:
        cursor.execute(
            "SELECT id, name, currency, closed_at FROM portfolio_positions WHERE id = ?",
            (position_id,),
        )
        position: Any | None = cursor.fetchone()
        if position is None:
            return error_response("Position not found", 404)
        history: dict[int, list[portfolio.Snapshot]] = _load_snapshots(
            cursor, [position_id]
        )

    snapshots: Sequence[portfolio.Snapshot] = portfolio.with_sale_recorded(
        history[position_id], position["closed_at"]
    )
    rows: list[portfolio.HistoryRow] = portfolio.history_rows(snapshots)

    return jsonify(
        {
            "position": {
                "id": position["id"],
                "name": position["name"],
                "currency": position["currency"],
                "closed_at": position["closed_at"],
            },
            "rows": [_serialize_history_row(row) for row in reversed(rows)],
        }
    )
