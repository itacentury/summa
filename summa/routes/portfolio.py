"""REST API routes for the portfolio area: depots, positions and weekly snapshots.

This module is the seam between SQLite and :mod:`summa.portfolio`. It reads rows,
maps them into that module's dataclasses, calls the derivations and serialises the
result — it deliberately carries no arithmetic of its own beyond rounding at the
JSON boundary, so every numeric rule stays provable without a request context.
"""

import logging
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Final

from flask import Blueprint, Response, jsonify, request

from summa import portfolio
from summa.db import chunked, db_cursor, placeholders_for
from summa.helpers import (
    ApiResponse,
    ValidationError,
    error_response,
    parse_float,
    require_non_empty_str,
)

logger: logging.Logger = logging.getLogger(__name__)

portfolio_bp: Blueprint = Blueprint("portfolio", __name__)

# The same allowlist the schema's CHECK holds. Validating it here too turns a
# constraint violation (a 500) into a 400 naming the accepted values.
POSITION_KINDS: Final[tuple[str, ...]] = ("etf", "fund", "stock")
DEFAULT_CURRENCY: Final[str] = "EUR"
# The explicit "no filter" token, so ?depot=all is intended behaviour rather than
# a side effect of int() failing.
DEPOT_ALL: Final[str] = "all"
CURRENCY_CODE_LENGTH: Final[int] = 3
SNAPSHOT_INTERVAL_DAYS: Final[int] = 7
AMOUNT_DIGITS: Final[int] = 2
PERCENT_DIGITS: Final[int] = 1

# Columns a PATCH may set. The keys are ours, never the client's strings, which
# is what makes building the SET clause from them safe.
_PATCHABLE_COLUMNS: Final[tuple[str, ...]] = (
    "name",
    "kind",
    "currency",
    "depot_id",
    "sort_order",
    "is_benchmark_fallback",
    "closed_at",
)


# --- Rounding ---------------------------------------------------------------
# summa.portfolio returns full precision on purpose; this is the only place that
# rounds. Rounding twice is how a subtotal stops matching the rows above it.


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


# --- Input validation -------------------------------------------------------


def _require_object(data: Any) -> dict[str, Any]:
    """Return the request body as a dict; raise ValidationError otherwise."""
    if not isinstance(data, dict):
        raise ValidationError("Request body must be a JSON object")
    return data


def _require_int(value: Any, field: str) -> int:
    """Return value as an int; raise ValidationError otherwise."""
    # bool is a subclass of int; reject it explicitly so `true` is not `1`.
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValidationError(f"Field '{field}' must be an integer", field=field)
    return value


def _require_bool(value: Any, field: str) -> bool:
    """Return value as a bool; raise ValidationError otherwise."""
    if not isinstance(value, bool):
        raise ValidationError(f"Field '{field}' must be true or false", field=field)
    return value


def _optional_float(value: Any, field: str) -> float | None:
    """Return value as a finite float, passing None through; raise on anything else."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValidationError(f"Field '{field}' must be a number", field=field)
    return parse_float(value, field)


def _require_kind(value: Any) -> str:
    """Return a valid position kind; raise ValidationError otherwise."""
    kind: str = require_non_empty_str(value, "kind").lower()
    if kind not in POSITION_KINDS:
        raise ValidationError(
            f"Field 'kind' must be one of: {', '.join(POSITION_KINDS)}", field="kind"
        )
    return kind


def _require_currency(value: Any) -> str:
    """Return an upper-cased three-letter currency code; raise ValidationError otherwise.

    Defaulting is the caller's job: inside a PATCH branch an explicit ``null``
    means "set this to null", not "leave it alone", so swallowing it here would
    silently overwrite the stored code.
    """
    code: str = require_non_empty_str(value, "currency").upper()
    if len(code) != CURRENCY_CODE_LENGTH or not (code.isascii() and code.isalpha()):
        raise ValidationError(
            "Field 'currency' must be a three-letter ISO code", field="currency"
        )
    return code


def _require_snapshot_date(value: Any) -> str:
    """Return a normalized ISO date; reject malformed and future dates.

    A snapshot records what a position was worth, so a date that has not
    happened yet cannot be observed.
    """
    text: str = require_non_empty_str(value, "date")
    try:
        parsed: date = date.fromisoformat(text)
    except ValueError:
        raise ValidationError(
            "Field 'date' must be an ISO date (YYYY-MM-DD)", field="date"
        ) from None
    if parsed > date.today():
        raise ValidationError("Snapshot date cannot be in the future", field="date")
    return parsed.isoformat()


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

    One query per chunk of positions rather than one per position, and
    ``ORDER BY date`` is what satisfies the ascending precondition every function
    in :mod:`summa.portfolio` relies on — chunking cannot disturb it, since a
    position's rows always land in a single chunk.
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

    # The order is global across depots, so it cannot come from a per-chunk
    # ORDER BY; sorting the merged rows keeps one source of ordering truth.
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
            # A sold position's closing row is derived here rather than stored,
            # so closing one never overwrites the week it was sold in.
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
    """The benchmark line plus where it came from."""

    values: list[float]
    source: str | None
    updated_at: str | None


def _feed_points(
    cursor: sqlite3.Cursor, start: str | None
) -> tuple[list[tuple[str, float]], str | None]:
    """Return the freshest feed symbol's closes inside the window and its last date.

    The symbol is implicit: whichever one in benchmark_prices carries the newest
    close, ties broken arbitrarily. That only holds while the feed job writes a
    single symbol. The planned Settings -> Portfolio "Benchmark" select (Part 8)
    has to pass a symbol in here, leaving this query as the no-selection default.
    """
    cursor.execute(
        "SELECT symbol, MAX(date) AS latest FROM benchmark_prices "
        "GROUP BY symbol ORDER BY latest DESC LIMIT 1"
    )
    row: Any = cursor.fetchone()
    if row is None:
        return [], None

    symbol: str = row["symbol"]
    updated_at: str = row["latest"]
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
    return points, updated_at


def _fallback_points(
    cursor: sqlite3.Cursor, start: str | None
) -> list[tuple[str, float]]:
    """Return the deposit-free growth of the position flagged as benchmark fallback.

    The lookup ignores the depot filter on purpose: the benchmark is the chart's
    yardstick, not a member of the selection, and the feed path is global for the
    same reason. Only one position carries the flag (_clear_other_fallbacks), so
    LIMIT 1 is the whole set.

    Its raw value series would not do: a week the user paid into would lift the
    benchmark line as if the index had risen.
    """
    cursor.execute(
        "SELECT id FROM portfolio_positions WHERE is_benchmark_fallback = 1 LIMIT 1"
    )
    row: Any = cursor.fetchone()
    if row is None:
        return []

    snapshots: list[portfolio.Snapshot] = _load_snapshots(cursor, [row["id"]])[
        row["id"]
    ]
    # Growth over the full history, then cut to the window: the first return
    # inside the window is still measured against the week before it, and
    # rebasing divides the constant factor back out anyway.
    points: list[tuple[str, float]] = []
    for point in portfolio.growth_points(snapshots):
        if start is None or point[0] >= start:
            points.append(point)
    return points


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

    A missing or stale feed is never an error: the chart still has to render, so
    the worst outcome is a line labelled ``fallback`` — or no third line at all.
    """
    points, updated_at = _feed_points(cursor, start)
    source: str | None = "feed"
    if not points:
        points = _fallback_points(cursor, start)
        source = "fallback"
        updated_at = points[-1][0] if points else None

    values: list[float] = portfolio.rebase_to_grid(points, grid, base)
    if not values:
        return _Benchmark(values=[], source=None, updated_at=None)
    return _Benchmark(values=values, source=source, updated_at=updated_at)


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


# --- Query parameters -------------------------------------------------------


def _requested_range() -> str:
    """Return the requested period token, falling back to the default.

    An unrecognized token degrades rather than 400-ing, the way ``sort_by``
    already does in ``get_invoices``: a stale client value must not blank the
    whole screen. The response echoes what was used so the client can correct
    itself.
    """
    token: str = request.args.get("range", portfolio.DEFAULT_RANGE)
    if token in portfolio.RANGE_TOKENS:
        return token
    return portfolio.DEFAULT_RANGE


def _requested_depot() -> int | None:
    """Return the requested depot id, or None for all depots.

    Unlike ``_requested_range``, a malformed value is rejected rather than
    degraded: a filter that silently widens to every depot answers a question the
    client did not ask, and the caller cannot tell the difference.
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

    The depot filter narrows everything, because it changes which positions
    exist for this request. The period token reaches only the chart: the list
    always shows current values.
    """
    range_token: str = _requested_range()

    try:
        depot_id: int | None = _requested_depot()

        with db_cursor() as cursor:
            depots: list[portfolio.Depot] = _load_depots(cursor, depot_id)
            # An id that matches no depot is a client bug, not an empty portfolio.
            if depot_id is not None and not depots:
                raise ValidationError("Depot not found", field="depot")
            positions: list[portfolio.Position] = _load_positions(
                cursor, [depot.id for depot in depots]
            )

            views: list[portfolio.PositionView] = [
                portfolio.build_position_view(position) for position in positions
            ]
            # One reading of the date for the whole response: two calls could land
            # on either side of midnight and describe a window the grid does not
            # match.
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
            },
            "benchmark_source": benchmark.source,
            "benchmark_updated_at": benchmark.updated_at,
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

    `previous_carried` marks a previous reading that was itself copied forward
    rather than entered, so the form can tell the user that the number it is
    comparing against is not a real one. A position without history reports
    False rather than None: there is no stale reading to warn about.
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

    # A closed position is sold: it still counts in the totals, but there is
    # nothing left to record a weekly value for. Its snapshot dates stay out of
    # the reply too — the form cannot write that position, so such a date is an
    # addition here rather than a replacement.
    active: list[portfolio.Position] = [
        position for position in positions if position.closed_at is None
    ]

    grouped: dict[int, list[dict[str, Any]]] = {depot.id: [] for depot in depots}
    for position in active:
        grouped[position.depot_id].append(_prefill_position(position))

    # The full set, not just the newest: the form warns about replacing any week
    # the user can backdate to.
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


@dataclass(frozen=True)
class _SnapshotRow:
    """One requested snapshot row, before the previous week has been consulted."""

    position_id: int
    value: float | None
    deposit: float | None
    fx_rate: float | None


@dataclass(frozen=True)
class _ResolvedRow:
    """One snapshot row with every gap filled from the previous week."""

    position_id: int
    value: float
    deposit: float
    fx_rate: float
    carried: bool


def _parse_snapshot_payload(data: Any) -> tuple[str, list[_SnapshotRow]]:
    """Validate a snapshot payload into its date and its rows."""
    payload: dict[str, Any] = _require_object(data)
    snapshot_date: str = _require_snapshot_date(payload.get("date"))

    raw_rows: Any = payload.get("rows")
    if not isinstance(raw_rows, list) or not raw_rows:
        raise ValidationError("Field 'rows' must be a non-empty list", field="rows")

    rows: list[_SnapshotRow] = []
    for raw_row in raw_rows:
        if not isinstance(raw_row, dict):
            raise ValidationError("Each row must be a JSON object", field="rows")
        fx_rate: float | None = _optional_float(raw_row.get("fx_rate"), "fx_rate")
        if fx_rate is not None and fx_rate <= 0:
            raise ValidationError(
                "Field 'fx_rate' must be greater than zero", field="fx_rate"
            )
        value: float | None = _optional_float(raw_row.get("value"), "value")
        if value is not None and value < 0:
            raise ValidationError("Field 'value' must not be negative", field="value")
        rows.append(
            _SnapshotRow(
                position_id=_require_int(raw_row.get("position_id"), "position_id"),
                value=value,
                deposit=_optional_float(raw_row.get("deposit"), "deposit"),
                fx_rate=fx_rate,
            )
        )
    return snapshot_date, rows


def _require_open_position(
    cursor: sqlite3.Cursor, position_id: int, snapshot_date: str
) -> None:
    """Reject an unknown position, and a week that falls after its sale.

    A snapshot dated after ``closed_at`` is discarded by
    :func:`summa.portfolio.with_sale_recorded` on every read, so writing one only
    stores a value that reappears the moment the position is reopened. A week at
    or before the sale stays writable: correcting it corrects the proceeds the
    closing row is derived from.
    """
    cursor.execute(
        "SELECT closed_at FROM portfolio_positions WHERE id = ?", (position_id,)
    )
    row: Any | None = cursor.fetchone()
    if row is None:
        raise ValidationError(f"Position {position_id} not found", field="position_id")

    closed_at: str | None = row["closed_at"]
    # ISO dates compare as text, as everywhere else in this module.
    if closed_at is not None and snapshot_date > closed_at:
        raise ValidationError(
            f"Position {position_id} was closed on {closed_at}", field="position_id"
        )


def _stored_snapshot(
    cursor: sqlite3.Cursor, position_id: int, snapshot_date: str
) -> Any | None:
    """Return the row already recorded for that exact week, if any."""
    cursor.execute(
        "SELECT value, deposit, fx_rate, carried FROM portfolio_snapshots "
        "WHERE position_id = ? AND date = ?",
        (position_id, snapshot_date),
    )
    return cursor.fetchone()


def _previous_snapshot(
    cursor: sqlite3.Cursor, position_id: int, before: str
) -> Any | None:
    """Return the position's most recent snapshot strictly before `before`."""
    cursor.execute(
        "SELECT value, deposit, fx_rate, carried FROM portfolio_snapshots "
        "WHERE position_id = ? AND date < ? ORDER BY date DESC LIMIT 1",
        (position_id, before),
    )
    return cursor.fetchone()


def _resolve_snapshot_row(
    row: _SnapshotRow, stored: Any | None, previous: Any | None
) -> _ResolvedRow:
    """Fill an empty value, deposit or FX rate from what is already known.

    On a new week an empty value carries the previous one forward and an empty
    deposit is 0 (handoff decision 9). On a re-post of a week that already has a
    row, an empty field preserves what is stored instead: the weekly form sends
    every position at once, so a user correcting one row re-posts blanks for all
    the others, and those must not be reverted or zeroed.

    The FX rate is inherited the same way, so a USD position keeps its rate
    without the weekly form having to ask for one.
    """
    if row.value is not None:
        value: float = row.value
        carried: bool = False
    elif stored is not None:
        value = stored["value"]
        carried = bool(stored["carried"])
    elif previous is not None:
        value = previous["value"]
        carried = True
    else:
        raise ValidationError(
            f"Position {row.position_id} has no earlier snapshot to carry forward",
            field="value",
        )

    deposit: float | None = row.deposit
    if deposit is None:
        deposit = 0.0 if stored is None else stored["deposit"]

    fx_rate: float | None = row.fx_rate
    if fx_rate is None:
        baseline: Any | None = stored if stored is not None else previous
        fx_rate = 1.0 if baseline is None else baseline["fx_rate"]

    return _ResolvedRow(
        position_id=row.position_id,
        value=value,
        deposit=deposit,
        fx_rate=fx_rate,
        carried=carried,
    )


@portfolio_bp.route("/api/portfolio/snapshot", methods=["POST"])
def save_snapshot() -> ApiResponse:
    """Record one week for a set of positions, idempotently per (position, date)."""
    try:
        snapshot_date, rows = _parse_snapshot_payload(request.json)
    except ValidationError as e:
        return error_response(e.message, 400)

    try:
        # One transaction for the whole week: a half-saved snapshot would leave a
        # portfolio value that matches no real point in time.
        with db_cursor() as cursor:
            for row in rows:
                _require_open_position(cursor, row.position_id, snapshot_date)
                stored: Any | None = _stored_snapshot(
                    cursor, row.position_id, snapshot_date
                )
                previous: Any | None = (
                    None
                    if stored is not None
                    else _previous_snapshot(cursor, row.position_id, snapshot_date)
                )
                resolved: _ResolvedRow = _resolve_snapshot_row(row, stored, previous)
                # Re-posting a date corrects it instead of colliding with the
                # UNIQUE constraint: the user fixing last week is the normal case.
                # Blank fields keep what that row already holds (see
                # _resolve_snapshot_row), so only what the user typed changes.
                cursor.execute(
                    "INSERT INTO portfolio_snapshots "
                    "(position_id, date, value, deposit, fx_rate, carried) "
                    "VALUES (?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(position_id, date) DO UPDATE SET "
                    "value = excluded.value, deposit = excluded.deposit, "
                    "fx_rate = excluded.fx_rate, carried = excluded.carried",
                    (
                        resolved.position_id,
                        snapshot_date,
                        resolved.value,
                        resolved.deposit,
                        resolved.fx_rate,
                        int(resolved.carried),
                    ),
                )
    except ValidationError as e:
        return error_response(e.message, 400)
    except sqlite3.Error as e:
        logger.error("Failed to save snapshot for %s: %s", snapshot_date, e)
        return error_response("Internal server error", 500)

    logger.info("Portfolio snapshot saved: date=%s, rows=%d", snapshot_date, len(rows))
    return jsonify({"success": True, "date": snapshot_date, "rows": len(rows)})


def _clear_other_fallbacks(cursor: sqlite3.Cursor, keep_id: int | None) -> None:
    """Leave exactly one benchmark fallback position.

    Two flagged positions would make the benchmark line depend on row order.
    """
    cursor.execute(
        "UPDATE portfolio_positions SET is_benchmark_fallback = 0 WHERE id != ?",
        (keep_id,),
    )


def _require_existing_depot(cursor: sqlite3.Cursor, depot_id: int) -> None:
    """Reject an unknown depot before the foreign key turns it into an IntegrityError."""
    cursor.execute("SELECT id FROM portfolio_depots WHERE id = ?", (depot_id,))
    if cursor.fetchone() is None:
        raise ValidationError("Depot not found", field="depot_id")


@portfolio_bp.route("/api/portfolio/positions", methods=["POST"])
def add_position() -> ApiResponse:
    """Create a position in a depot."""
    try:
        payload: dict[str, Any] = _require_object(request.json)
        depot_id: int = _require_int(payload.get("depot_id"), "depot_id")
        name: str = require_non_empty_str(payload.get("name"), "name")
        kind: str = _require_kind(payload.get("kind"))
        currency: str = _require_currency(payload.get("currency", DEFAULT_CURRENCY))
        is_fallback: bool = _require_bool(
            payload.get("is_benchmark_fallback", False), "is_benchmark_fallback"
        )
        sort_order: int = _require_int(payload.get("sort_order", 0), "sort_order")
    except ValidationError as e:
        return error_response(e.message, 400)

    position_id: int | None = None
    try:
        with db_cursor() as cursor:
            _require_existing_depot(cursor, depot_id)
            cursor.execute(
                "INSERT INTO portfolio_positions "
                "(depot_id, name, kind, currency, is_benchmark_fallback, sort_order) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (depot_id, name, kind, currency, int(is_fallback), sort_order),
            )
            position_id = cursor.lastrowid
            if is_fallback:
                _clear_other_fallbacks(cursor, position_id)
    except ValidationError as e:
        return error_response(e.message, 400)
    except sqlite3.IntegrityError:
        return error_response(
            f"A position named '{name}' already exists in this depot", 409
        )
    except sqlite3.Error as e:
        logger.error("Failed to create position '%s': %s", name, e)
        return error_response("Internal server error", 500)

    logger.info(
        "Portfolio position created: id=%s, name='%s', depot=%d",
        position_id,
        name,
        depot_id,
    )
    return jsonify({"success": True, "id": position_id})


def _parse_position_patch(data: Any) -> dict[str, Any]:
    """Validate a partial position update into column/value pairs.

    Only keys actually present are updated, so a PATCH never overwrites a field
    the client did not mention.
    """
    payload: dict[str, Any] = _require_object(data)
    updates: dict[str, Any] = {}

    if "name" in payload:
        updates["name"] = require_non_empty_str(payload["name"], "name")
    if "kind" in payload:
        updates["kind"] = _require_kind(payload["kind"])
    if "currency" in payload:
        updates["currency"] = _require_currency(payload["currency"])
    if "depot_id" in payload:
        updates["depot_id"] = _require_int(payload["depot_id"], "depot_id")
    if "sort_order" in payload:
        updates["sort_order"] = _require_int(payload["sort_order"], "sort_order")
    if "is_benchmark_fallback" in payload:
        updates["is_benchmark_fallback"] = int(
            _require_bool(payload["is_benchmark_fallback"], "is_benchmark_fallback")
        )
    if "close" in payload:
        closing: bool = _require_bool(payload["close"], "close")
        # Selling is always dated today: a backdated close would retroactively
        # withdraw money from weeks the user has already seen reported.
        updates["closed_at"] = date.today().isoformat() if closing else None

    if not updates:
        raise ValidationError("No updatable fields in request body")
    return updates


def _assignment(column: str, value: Any) -> str:
    """Return one SET clause for a patched column.

    Closing keeps an existing sale date: the user sold once, on the day the
    column already records, so a second close must not re-date that sale.
    Reopening writes NULL unconditionally.
    """
    if column == "closed_at" and value is not None:
        return "closed_at = COALESCE(closed_at, ?)"
    return f"{column} = ?"


@portfolio_bp.route("/api/portfolio/positions/<int:position_id>", methods=["PATCH"])
def update_position(position_id: int) -> ApiResponse:
    """Rename, reclassify, move or close a position.

    Closing and reopening both only move the ``closed_at`` column: the snapshot
    that takes a sold position's money back out is derived on every read by
    :func:`summa.portfolio.with_sale_recorded`. Nothing the user entered is
    rewritten, so the round trip is exactly reversible, and closing an
    already-closed position keeps the date of the first close. Reopening brings
    back the state the position was closed in, because no week after the sale can
    be recorded while it is closed (see :func:`_require_open_position`).
    """
    try:
        updates: dict[str, Any] = _parse_position_patch(request.json)
    except ValidationError as e:
        return error_response(e.message, 400)

    # The column names come from _parse_position_patch's own keys, never from the
    # request body, so interpolating them carries no injection surface. Checked
    # rather than asserted, because an assert would vanish under `python -O`.
    unknown_columns: set[str] = set(updates) - set(_PATCHABLE_COLUMNS)
    if unknown_columns:
        raise ValueError(f"Not a patchable column: {sorted(unknown_columns)}")
    assignments: str = ", ".join(
        _assignment(column, value) for column, value in updates.items()
    )

    try:
        with db_cursor() as cursor:
            if "depot_id" in updates:
                _require_existing_depot(cursor, updates["depot_id"])
            cursor.execute(
                f"UPDATE portfolio_positions SET {assignments} WHERE id = ?",
                [*updates.values(), position_id],
            )
            if cursor.rowcount == 0:
                return error_response("Position not found", 404)
            if updates.get("is_benchmark_fallback"):
                _clear_other_fallbacks(cursor, position_id)
    except ValidationError as e:
        return error_response(e.message, 400)
    except sqlite3.IntegrityError:
        return error_response("A position with that name already exists", 409)
    except sqlite3.Error as e:
        logger.error("Failed to update position id=%d: %s", position_id, e)
        return error_response("Internal server error", 500)

    logger.info(
        "Portfolio position updated: id=%d, fields=%s",
        position_id,
        ",".join(updates),
    )
    return jsonify({"success": True})


@portfolio_bp.route("/api/portfolio/depots", methods=["POST"])
def add_depot() -> ApiResponse:
    """Create a depot to group positions under."""
    try:
        payload: dict[str, Any] = _require_object(request.json)
        name: str = require_non_empty_str(payload.get("name"), "name")
        sort_order: int = _require_int(payload.get("sort_order", 0), "sort_order")
    except ValidationError as e:
        return error_response(e.message, 400)

    depot_id: int | None = None
    try:
        with db_cursor() as cursor:
            cursor.execute(
                "INSERT INTO portfolio_depots (name, sort_order) VALUES (?, ?)",
                (name, sort_order),
            )
            depot_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        return error_response(f"A depot named '{name}' already exists", 409)
    except sqlite3.Error as e:
        logger.error("Failed to create depot '%s': %s", name, e)
        return error_response("Internal server error", 500)

    logger.info("Portfolio depot created: id=%s, name='%s'", depot_id, name)
    return jsonify({"success": True, "id": depot_id})
