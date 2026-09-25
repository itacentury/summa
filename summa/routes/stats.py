"""REST API route for aggregate invoice statistics."""

import logging
import sqlite3
from datetime import date, timedelta
from typing import Any, cast

from flask import Blueprint, Response, jsonify, request

from summa.db import db_cursor
from summa.queries import build_invoice_filter

logger: logging.Logger = logging.getLogger(__name__)

stats_bp: Blueprint = Blueprint("stats", __name__)


def _calculate_comparison(
    cursor: sqlite3.Cursor,
    date_from: str,
    date_to: str,
    total_amount: float,
) -> dict[str, Any]:
    """Calculate spending comparison with the previous period of equal length."""
    comparison: dict[str, Any] = {"previous_total": 0, "change_percent": 0}
    if not (date_from and date_to):
        return comparison

    try:
        start: date = date.fromisoformat(date_from)
        end: date = date.fromisoformat(date_to)
        # fromisoformat also takes basic/week forms the string-compared main query filters differently.
        if start.isoformat() != date_from or end.isoformat() != date_to:
            raise ValueError("dates must be YYYY-MM-DD")
        period_days: int = (end - start).days + 1

        prev_end: date = start - timedelta(days=1)
        prev_start: date = prev_end - timedelta(days=period_days - 1)

        cursor.execute(
            "SELECT COALESCE(SUM(total), 0) as sum FROM invoices "
            "WHERE deleted_at IS NULL AND date >= ? AND date <= ?",
            (prev_start.isoformat(), prev_end.isoformat()),
        )
        # An aggregate without GROUP BY always yields exactly one row.
        prev_total: float = cast(sqlite3.Row, cursor.fetchone())["sum"]
        comparison["previous_total"] = round(prev_total, 2)

        if prev_total > 0:
            comparison["change_percent"] = round(
                ((total_amount - prev_total) / prev_total) * 100, 1
            )
    except ValueError:
        logger.warning(
            "Invalid date format for comparison: date_from='%s', date_to='%s'",
            date_from,
            date_to,
        )

    return comparison


@stats_bp.route("/api/stats", methods=["GET"])
def get_stats() -> Response:
    """Return aggregate statistics about invoices with optional date filtering."""
    date_from: str = request.args.get("date_from", "")
    date_to: str = request.args.get("date_to", "")
    where, params = build_invoice_filter({"date_from": date_from, "date_to": date_to})

    with db_cursor() as cursor:
        # Summary statistics
        cursor.execute(
            f"SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as sum "
            f"FROM invoices {where}",
            params,
        )
        row: sqlite3.Row = cast(sqlite3.Row, cursor.fetchone())
        total_invoices: int = row["count"]
        total_amount: float = row["sum"]

        # Category breakdown
        cursor.execute(
            f"""SELECT COALESCE(category, 'Uncategorized') as category,
                       SUM(total) as amount, COUNT(*) as count
                FROM invoices {where}
                GROUP BY category ORDER BY amount DESC""",
            params,
        )
        by_category: list[dict[str, Any]] = [
            {
                "category": r["category"],
                "amount": round(r["amount"], 2),
                "count": r["count"],
            }
            for r in cursor.fetchall()
        ]

        # Store breakdown (top 10)
        cursor.execute(
            f"""SELECT store, SUM(total) as amount, COUNT(*) as count
                FROM invoices {where}
                GROUP BY store ORDER BY amount DESC LIMIT 10""",
            params,
        )
        by_store: list[dict[str, Any]] = [
            {"store": r["store"], "amount": round(r["amount"], 2), "count": r["count"]}
            for r in cursor.fetchall()
        ]

        comparison: dict[str, Any] = _calculate_comparison(
            cursor, date_from, date_to, total_amount
        )

    average_invoice: float = total_amount / total_invoices if total_invoices > 0 else 0

    return jsonify(
        {
            "summary": {
                "total_amount": round(total_amount, 2),
                "total_invoices": total_invoices,
                "average_invoice": round(average_invoice, 2),
            },
            "by_category": by_category,
            "by_store": by_store,
            "comparison": comparison,
        }
    )
