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
from summa.db import db_cursor, placeholders_for
from summa.helpers import (
    ApiResponse,
    ValidationError,
    error_response,
    require_non_empty_str,
)

logger: logging.Logger = logging.getLogger(__name__)

portfolio_bp: Blueprint = Blueprint("portfolio", __name__)

# The same allowlist the schema's CHECK holds. Validating it here too turns a
# constraint violation (a 500) into a 400 naming the accepted values.
POSITION_KINDS: Final[tuple[str, ...]] = ("etf", "fund", "stock")
DEFAULT_CURRENCY: Final[str] = "EUR"
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
    """Return value as a float, passing None through; raise on anything else."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValidationError(f"Field '{field}' must be a number", field=field)
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValidationError(
            f"Field '{field}' must be a number", field=field
        ) from None


def _require_kind(value: Any) -> str:
    """Return a valid position kind; raise ValidationError otherwise."""
    kind: str = require_non_empty_str(value, "kind").lower()
    if kind not in POSITION_KINDS:
        raise ValidationError(
            f"Field 'kind' must be one of: {', '.join(POSITION_KINDS)}", field="kind"
        )
    return kind


def _require_currency(value: Any) -> str:
    """Return an upper-cased three-letter currency code, defaulting to EUR."""
    if value is None:
        return DEFAULT_CURRENCY
    code: str = require_non_empty_str(value, "currency").upper()
    if len(code) != CURRENCY_CODE_LENGTH or not code.isalpha():
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

    One query rather than one per position, and ``ORDER BY date`` is what
    satisfies the ascending precondition every function in
    :mod:`summa.portfolio` relies on.
    """
    history: dict[int, list[portfolio.Snapshot]] = {
        position_id: [] for position_id in position_ids
    }
    cursor.execute(
        "SELECT position_id, date, value, deposit, fx_rate, carried "
        f"FROM portfolio_snapshots WHERE position_id IN ({placeholders_for(len(position_ids))}) "
        "ORDER BY position_id, date",
        list(position_ids),
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

    cursor.execute(
        "SELECT id, depot_id, name, kind, currency, is_benchmark_fallback, "
        "closed_at, sort_order FROM portfolio_positions "
        f"WHERE depot_id IN ({placeholders_for(len(depot_ids))}) "
        "ORDER BY sort_order, name",
        list(depot_ids),
    )
    rows: list[Any] = cursor.fetchall()
    if not rows:
        return []

    position_ids: list[int] = [row["id"] for row in rows]
    history: dict[int, list[portfolio.Snapshot]] = _load_snapshots(cursor, position_ids)
    return [
        portfolio.Position(
            id=row["id"],
            depot_id=row["depot_id"],
            name=row["name"],
            kind=row["kind"],
            currency=row["currency"],
            snapshots=history[row["id"]],
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
    """Return the freshest feed symbol's closes inside the window and its last date."""
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
    positions: Sequence[portfolio.Position], start: str | None
) -> list[tuple[str, float]]:
    """Return the deposit-free growth of the position flagged as benchmark fallback.

    Its raw value series would not do: a week the user paid into would lift the
    benchmark line as if the index had risen.
    """
    points: list[tuple[str, float]] = []
    for position in positions:
        if not position.is_benchmark_fallback:
            continue
        # Growth over the full history, then cut to the window: the first return
        # inside the window is still measured against the week before it, and
        # rebasing divides the constant factor back out anyway.
        for point in portfolio.growth_points(position.snapshots):
            if start is None or point[0] >= start:
                points.append(point)
        break
    return points


def _series_base(values: Sequence[float]) -> float:
    """Return the first non-zero value of a series — what the benchmark indexes to."""
    for value in values:
        if value != 0:
            return value
    return 0.0


def _build_benchmark(
    cursor: sqlite3.Cursor,
    positions: Sequence[portfolio.Position],
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
        points = _fallback_points(positions, start)
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
        "is_closed": view.is_closed,
        "value": _amount(view.value),
        "fx_rate": view.fx_rate,
        "value_eur": _amount(view.value_eur),
        "invested_eur": _amount(view.invested_eur),
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
        "gain": _amount(view.gain),
        "gain_pct": _optional_percent(view.gain_pct),
    }


def _serialize_totals(totals: portfolio.PortfolioTotals) -> dict[str, Any]:
    """Render the grand total behind the three summary cards."""
    return {
        "value_eur": _amount(totals.value_eur),
        "invested_eur": _amount(totals.invested_eur),
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
        "share_pct": _optional_percent(allocation_slice.share_pct),
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
    """Return the requested depot id, or None for all depots."""
    try:
        return int(request.args.get("depot", ""))
    except (TypeError, ValueError):
        return None


# --- Routes -----------------------------------------------------------------


@portfolio_bp.route("/api/portfolio", methods=["GET"])
def get_portfolio() -> Response:
    """Return the whole Portfolio screen: groups, totals, allocation, series.

    The depot filter narrows everything, because it changes which positions
    exist for this request. The period token reaches only the chart: the list
    always shows current values.
    """
    range_token: str = _requested_range()
    depot_id: int | None = _requested_depot()

    with db_cursor() as cursor:
        depots: list[portfolio.Depot] = _load_depots(cursor, depot_id)
        positions: list[portfolio.Position] = _load_positions(
            cursor, [depot.id for depot in depots]
        )

        views: list[portfolio.PositionView] = [
            portfolio.build_position_view(position) for position in positions
        ]
        start: date | None = portfolio.range_start(range_token, date.today())
        grid: list[str] = portfolio.snapshot_dates(positions, start)
        series: portfolio.ChartSeries = portfolio.build_series(positions, grid)
        benchmark: _Benchmark = _build_benchmark(
            cursor,
            positions,
            grid,
            _series_base(series.portfolio),
            start.isoformat() if start is not None else None,
        )

    depot_views: list[portfolio.DepotView] = portfolio.build_depot_views(depots, views)
    totals: portfolio.PortfolioTotals = portfolio.build_totals(views, len(depots))
    gainers, losers = portfolio.biggest_changes(views)

    return jsonify(
        {
            "range": range_token,
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
    """Render one position for the weekly entry form, with its previous reading."""
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
    # nothing left to record a weekly value for.
    grouped: dict[int, list[dict[str, Any]]] = {depot.id: [] for depot in depots}
    last_snapshot_date: str | None = None
    for position in positions:
        if position.closed_at is not None:
            continue
        grouped[position.depot_id].append(_prefill_position(position))
        if position.snapshots:
            latest: str = position.snapshots[-1].date
            # ISO dates compare as text, so no parsing is needed to find the max.
            if last_snapshot_date is None or latest > last_snapshot_date:
                last_snapshot_date = latest

    return jsonify(
        {
            "suggested_date": _suggested_snapshot_date(last_snapshot_date),
            "last_snapshot_date": last_snapshot_date,
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
        rows.append(
            _SnapshotRow(
                position_id=_require_int(raw_row.get("position_id"), "position_id"),
                value=_optional_float(raw_row.get("value"), "value"),
                deposit=_optional_float(raw_row.get("deposit"), "deposit"),
                fx_rate=fx_rate,
            )
        )
    return snapshot_date, rows


def _previous_snapshot(
    cursor: sqlite3.Cursor, position_id: int, before: str
) -> Any | None:
    """Return the position's most recent snapshot strictly before `before`."""
    cursor.execute(
        "SELECT value, fx_rate FROM portfolio_snapshots "
        "WHERE position_id = ? AND date < ? ORDER BY date DESC LIMIT 1",
        (position_id, before),
    )
    return cursor.fetchone()


def _resolve_snapshot_row(row: _SnapshotRow, previous: Any | None) -> _ResolvedRow:
    """Fill an empty value, deposit or FX rate from the previous week.

    An empty value carries the previous one forward (handoff decision 9). The FX
    rate is inherited the same way, so a USD position keeps its rate without the
    weekly form having to ask for one.
    """
    if row.value is not None:
        value: float = row.value
        carried: bool = False
    elif previous is not None:
        value = previous["value"]
        carried = True
    else:
        raise ValidationError(
            f"Position {row.position_id} has no earlier snapshot to carry forward",
            field="value",
        )

    fx_rate: float | None = row.fx_rate
    if fx_rate is None:
        fx_rate = 1.0 if previous is None else previous["fx_rate"]

    return _ResolvedRow(
        position_id=row.position_id,
        value=value,
        deposit=0.0 if row.deposit is None else row.deposit,
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
                cursor.execute(
                    "SELECT id FROM portfolio_positions WHERE id = ?",
                    (row.position_id,),
                )
                if cursor.fetchone() is None:
                    raise ValidationError(
                        f"Position {row.position_id} not found", field="position_id"
                    )
                resolved: _ResolvedRow = _resolve_snapshot_row(
                    row, _previous_snapshot(cursor, row.position_id, snapshot_date)
                )
                # Re-posting a date corrects it instead of colliding with the
                # UNIQUE constraint: the user fixing last week is the normal case.
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
        currency: str = _require_currency(payload.get("currency"))
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
        updates["closed_at"] = date.today().isoformat() if closing else None

    if not updates:
        raise ValidationError("No updatable fields in request body")
    return updates


@portfolio_bp.route("/api/portfolio/positions/<int:position_id>", methods=["PATCH"])
def update_position(position_id: int) -> ApiResponse:
    """Rename, reclassify, move or close a position."""
    try:
        updates: dict[str, Any] = _parse_position_patch(request.json)
    except ValidationError as e:
        return error_response(e.message, 400)

    # The column names come from _parse_position_patch's own keys, never from the
    # request body, so interpolating them carries no injection surface.
    assert all(column in _PATCHABLE_COLUMNS for column in updates)
    assignments: str = ", ".join(f"{column} = ?" for column in updates)

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
