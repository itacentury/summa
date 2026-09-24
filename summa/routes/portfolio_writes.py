"""REST API routes that write the portfolio area: weekly snapshots, positions and depots.

The reads live in :mod:`summa.routes.portfolio`; nothing here derives a number,
it only validates a request and stores the raw facts it carries.
"""

import logging
import sqlite3
from dataclasses import dataclass
from datetime import date
from typing import Any, Final

from flask import Blueprint, jsonify, request

from summa.db import db_cursor
from summa.helpers import (
    ApiResponse,
    ValidationError,
    error_response,
    parse_float,
    require_non_empty_str,
)
from summa.portfolio import CURRENCY_CODE_LENGTH, DEFAULT_CURRENCY

logger: logging.Logger = logging.getLogger(__name__)

portfolio_writes_bp: Blueprint = Blueprint("portfolio_writes", __name__)

# The same allowlist the schema's CHECK holds. Validating it here too turns a
# constraint violation (a 500) into a 400 naming the accepted values.
POSITION_KINDS: Final[tuple[str, ...]] = ("etf", "fund", "stock")

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
_PATCHABLE_DEPOT_COLUMNS: Final[tuple[str, ...]] = ("name", "sort_order")


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


# --- Weekly snapshot --------------------------------------------------------


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


@portfolio_writes_bp.route("/api/portfolio/snapshot", methods=["POST"])
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


# --- Positions and depots ---------------------------------------------------


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


@portfolio_writes_bp.route("/api/portfolio/positions", methods=["POST"])
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


def _apply_patch(
    cursor: sqlite3.Cursor,
    table: str,
    row_id: int,
    updates: dict[str, Any],
    allowed: tuple[str, ...],
) -> bool:
    """Write a validated PATCH to one row and return whether that row exists.

    The column names come from the parser's own keys, never from the request
    body, so interpolating them carries no injection surface. Checked rather than
    asserted, because an assert would vanish under `python -O`.
    """
    unknown_columns: set[str] = set(updates) - set(allowed)
    if unknown_columns:
        raise ValueError(f"Not a patchable column: {sorted(unknown_columns)}")
    assignments: str = ", ".join(
        _assignment(column, value) for column, value in updates.items()
    )
    cursor.execute(
        f"UPDATE {table} SET {assignments} WHERE id = ?", [*updates.values(), row_id]
    )
    return cursor.rowcount > 0


@portfolio_writes_bp.route(
    "/api/portfolio/positions/<int:position_id>", methods=["PATCH"]
)
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

    try:
        with db_cursor() as cursor:
            if "depot_id" in updates:
                _require_existing_depot(cursor, updates["depot_id"])
            if not _apply_patch(
                cursor, "portfolio_positions", position_id, updates, _PATCHABLE_COLUMNS
            ):
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


@portfolio_writes_bp.route("/api/portfolio/depots", methods=["POST"])
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


def _parse_depot_patch(data: Any) -> dict[str, Any]:
    """Validate a partial depot update into column/value pairs.

    Only keys actually present are updated, so a PATCH never overwrites a field
    the client did not mention.
    """
    payload: dict[str, Any] = _require_object(data)
    updates: dict[str, Any] = {}

    if "name" in payload:
        updates["name"] = require_non_empty_str(payload["name"], "name")
    if "sort_order" in payload:
        updates["sort_order"] = _require_int(payload["sort_order"], "sort_order")

    if not updates:
        raise ValidationError("No updatable fields in request body")
    return updates


@portfolio_writes_bp.route("/api/portfolio/depots/<int:depot_id>", methods=["PATCH"])
def update_depot(depot_id: int) -> ApiResponse:
    """Rename a depot or move it in the sort order.

    Nothing below the depot is touched: its positions keep their ids, so a
    corrected name reaches every group header and snapshot row without rewriting
    a single number.
    """
    try:
        updates: dict[str, Any] = _parse_depot_patch(request.json)
    except ValidationError as e:
        return error_response(e.message, 400)

    try:
        with db_cursor() as cursor:
            if not _apply_patch(
                cursor, "portfolio_depots", depot_id, updates, _PATCHABLE_DEPOT_COLUMNS
            ):
                return error_response("Depot not found", 404)
    except sqlite3.IntegrityError:
        return error_response(
            f"A depot named '{updates.get('name')}' already exists", 409
        )
    except sqlite3.Error as e:
        logger.error("Failed to update depot id=%d: %s", depot_id, e)
        return error_response("Internal server error", 500)

    logger.info(
        "Portfolio depot updated: id=%d, fields=%s", depot_id, ",".join(updates)
    )
    return jsonify({"success": True})
