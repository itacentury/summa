"""REST API route for aggregate invoice statistics."""

import logging
import sqlite3
from datetime import datetime, timedelta
from typing import Any

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
        start: datetime = datetime.strptime(date_from, "%Y-%m-%d")
        end: datetime = datetime.strptime(date_to, "%Y-%m-%d")
        period_days: int = (end - start).days + 1

        prev_end: datetime = start - timedelta(days=1)
        prev_start: datetime = prev_end - timedelta(days=period_days - 1)

        cursor.execute(
            "SELECT SUM(total) as sum FROM invoices "
            "WHERE deleted_at IS NULL AND date >= ? AND date <= ?",
            (prev_start.strftime("%Y-%m-%d"), prev_end.strftime("%Y-%m-%d")),
        )
        prev_row: sqlite3.Row | None = cursor.fetchone()
        assert prev_row is not None  # SUM aggregate always returns exactly one row
        prev_total: float = prev_row["sum"] or 0
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
            f"SELECT COUNT(*) as count, SUM(total) as sum FROM invoices {where}",
            params,
        )
        row: sqlite3.Row | None = cursor.fetchone()
        assert row is not None  # COUNT(*)/SUM aggregate always returns exactly one row
        total_invoices: int = row["count"]
        total_amount: float = row["sum"] or 0

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
