"""Flask web application for managing and analyzing invoices.

Provides REST API endpoints for CRUD operations on invoices,
bulk operations, statistics, and a web interface for visualization.
"""

import os
import sqlite3
from datetime import datetime, timedelta
from typing import Any, Final

from flask import Flask, Response, jsonify, render_template, request
from flask_cors import CORS

app: Flask = Flask(__name__)
CORS(app)  # Enable CORS for all routes (required for native mobile apps)
DATABASE: Final[str] = os.environ.get("DATABASE_PATH", "invoices.db")

# Type alias for API responses that may include HTTP status codes
ApiResponse = Response | tuple[Response, int]


def get_db() -> sqlite3.Connection:
    """Create and return a database connection with WAL mode enabled."""
    conn: sqlite3.Connection = sqlite3.connect(DATABASE, timeout=30.0)
    conn.row_factory = sqlite3.Row
    # Enable WAL mode for better concurrency
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def strip_text(value: Any) -> str | None:
    """Strip whitespace from text values, returning None for empty strings."""
    if value is None:
        return None
    stripped = str(value).strip()
    return stripped if stripped else None


def init_db() -> None:
    """Initialize the database schema and apply migrations if needed."""
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            store TEXT NOT NULL,
            category TEXT DEFAULT NULL,
            total REAL NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP DEFAULT NULL
        )
    """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            item_name TEXT NOT NULL,
            item_price REAL NOT NULL,
            FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE
        )
    """
    )

    # Migration: Add deleted_at column if it doesn't exist (for existing databases)
    cursor.execute("PRAGMA table_info(invoices)")
    columns: list[str] = [column[1] for column in cursor.fetchall()]
    if "deleted_at" not in columns:
        try:
            cursor.execute(
                "ALTER TABLE invoices ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL"
            )
        except sqlite3.OperationalError:
            pass  # Column already added by another worker

    if "category" not in columns:
        try:
            cursor.execute("ALTER TABLE invoices ADD COLUMN category TEXT DEFAULT NULL")
        except sqlite3.OperationalError:
            pass  # Column already added by another worker

    conn.commit()
    conn.close()


@app.route("/")
def index() -> str:
    """Render the main web interface."""
    return render_template("index.html")


@app.route("/api/invoices", methods=["GET"])
def get_invoices() -> Response:
    """Retrieve all invoices with optional filtering and sorting."""
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    # Get filter parameters
    filters: dict[str, str] = {
        "search": request.args.get("search", ""),
        "store": request.args.get("store", ""),
        "category": request.args.get("category", ""),
        "date_from": request.args.get("date_from", ""),
        "date_to": request.args.get("date_to", ""),
        "sort_by": request.args.get("sort_by", "date"),
        "sort_order": request.args.get("sort_order", "desc"),
    }

    # Build query - exclude soft-deleted invoices
    query: str = "SELECT * FROM invoices WHERE deleted_at IS NULL"
    params: list[str] = []

    if filters["search"]:
        query += (
            " AND (store LIKE ? OR id IN "
            "(SELECT invoice_id FROM invoice_items WHERE item_name LIKE ?))"
        )
        params.extend([f"%{filters['search']}%", f"%{filters['search']}%"])

    if filters["store"]:
        query += " AND store = ?"
        params.append(filters["store"])

    if filters["category"]:
        query += " AND category = ?"
        params.append(filters["category"])

    if filters["date_from"]:
        query += " AND date >= ?"
        params.append(filters["date_from"])

    if filters["date_to"]:
        query += " AND date <= ?"
        params.append(filters["date_to"])

    # Sorting
    if filters["sort_by"] in ["date", "store", "total"]:
        order: str = "DESC" if filters["sort_order"] == "desc" else "ASC"
        query += f" ORDER BY {filters['sort_by']} {order}"

    cursor.execute(query, params)

    result: list[dict[str, str | list[dict[str, str]]]] = []
    for invoice in cursor.fetchall():
        cursor.execute(
            "SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice["id"],)
        )
        result.append(
            {
                "id": invoice["id"],
                "date": invoice["date"],
                "store": invoice["store"],
                "category": invoice["category"],
                "total": invoice["total"],
                "items": [
                    {"item_name": item["item_name"], "item_price": item["item_price"]}
                    for item in cursor.fetchall()
                ],
            }
        )

    conn.close()
    return jsonify(result)


@app.route("/api/stores", methods=["GET"])
def get_stores() -> Response:
    """Return a list of all unique store names."""
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()
    cursor.execute(
        "SELECT DISTINCT store FROM invoices WHERE deleted_at IS NULL ORDER BY store"
    )
    stores: list[str] = [row["store"] for row in cursor.fetchall()]
    conn.close()
    return jsonify(stores)


@app.route("/api/categories", methods=["GET"])
def get_categories() -> Response:
    """Return a list of all unique invoice categories."""
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()
    cursor.execute(
        "SELECT DISTINCT category FROM invoices "
        "WHERE deleted_at IS NULL AND category IS NOT NULL ORDER BY category"
    )
    categories: list[str] = [row["category"] for row in cursor.fetchall()]
    conn.close()
    return jsonify(categories)


@app.route("/api/invoices", methods=["POST"])
def add_invoice() -> Response:
    """Create a new invoice with its associated items."""
    data: Any = request.json
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    cursor.execute(
        "INSERT INTO invoices (date, store, category, total) VALUES (?, ?, ?, ?)",
        (
            strip_text(data["date"]),
            strip_text(data["store"]),
            strip_text(data.get("category")),
            float(data["total"]),
        ),
    )
    invoice_id: int | None = cursor.lastrowid

    for item in data.get("items", []):
        cursor.execute(
            "INSERT INTO invoice_items (invoice_id, item_name, item_price) VALUES (?, ?, ?)",
            (invoice_id, strip_text(item["item_name"]), float(item["item_price"])),
        )

    conn.commit()
    conn.close()
    return jsonify({"success": True, "id": invoice_id})


@app.route("/api/invoices/import", methods=["POST"])
def import_invoices() -> ApiResponse:
    """Bulk import invoices, skipping duplicates based on date, store, and total."""
    data: Any = request.json
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    imported_count: int = 0
    skipped_count: int = 0

    try:
        for invoice_data in data:
            store = strip_text(invoice_data["store"])
            date = strip_text(invoice_data["date"])
            category = strip_text(invoice_data.get("category"))
            total = float(invoice_data["total"])

            # Duplikatsprüfung: Gleiche Kombination aus Datum, Geschäft und Gesamtbetrag
            cursor.execute(
                "SELECT id FROM invoices WHERE date = ? AND store = ? AND total = ?",
                (date, store, total),
            )
            existing: Any = cursor.fetchone()

            if existing:
                skipped_count += 1
                continue

            cursor.execute(
                "INSERT INTO invoices (date, store, category, total) VALUES (?, ?, ?, ?)",
                (date, store, category, total),
            )
            invoice_id: int | None = cursor.lastrowid

            for item in invoice_data.get("items", []):
                cursor.execute(
                    "INSERT INTO invoice_items "
                    "(invoice_id, item_name, item_price) VALUES (?, ?, ?)",
                    (
                        invoice_id,
                        strip_text(item["item_name"]),
                        float(item["item_price"]),
                    ),
                )
            imported_count += 1

        conn.commit()
        return jsonify(
            {"success": True, "imported": imported_count, "skipped": skipped_count}
        )
    except sqlite3.Error as e:
        conn.rollback()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()


@app.route("/api/invoices/<int:invoice_id>", methods=["PUT"])
def update_invoice(invoice_id: int) -> ApiResponse:
    """Update an existing invoice and replace all its items."""
    data: Any = request.json
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    try:
        # Update invoice
        cursor.execute(
            "UPDATE invoices SET date = ?, store = ?, category = ?, total = ? WHERE id = ?",
            (
                strip_text(data["date"]),
                strip_text(data["store"]),
                strip_text(data.get("category")),
                float(data["total"]),
                invoice_id,
            ),
        )

        # Delete existing items
        cursor.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (invoice_id,))

        # Insert new items
        for item in data.get("items", []):
            cursor.execute(
                "INSERT INTO invoice_items (invoice_id, item_name, item_price) VALUES (?, ?, ?)",
                (invoice_id, strip_text(item["item_name"]), float(item["item_price"])),
            )

        conn.commit()
        return jsonify({"success": True})
    except sqlite3.Error as e:
        conn.rollback()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()


@app.route("/api/invoices/<int:invoice_id>", methods=["DELETE"])
def delete_invoice(invoice_id: int) -> Response:
    """Soft-delete an invoice by setting its deleted_at timestamp."""
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()
    # Soft delete: set deleted_at timestamp instead of removing from database
    cursor.execute(
        "UPDATE invoices SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
        (invoice_id,),
    )
    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/invoices/bulk-update", methods=["PUT"])
def bulk_update_invoices() -> ApiResponse:
    """Update store name and/or category for multiple invoices at once."""
    data: Any = request.json
    invoice_ids: list[int] = data.get("ids", [])
    new_store: str | None = strip_text(data.get("store"))
    new_category: str | None = data.get("category")

    if not invoice_ids:
        return jsonify({"success": False, "error": "Missing ids"}), 400

    if not new_store and new_category is None:
        return jsonify({"success": False, "error": "Missing store or category"}), 400

    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    try:
        placeholders: str = ",".join("?" * len(invoice_ids))
        set_clauses: list[str] = []
        params: list[str | int | None] = []

        if new_store:
            set_clauses.append("store = ?")
            params.append(new_store)

        if new_category is not None:
            set_clauses.append("category = ?")
            # Empty string means remove category (set to NULL)
            params.append(strip_text(new_category))

        params.extend(invoice_ids)
        cursor.execute(
            f"UPDATE invoices SET {', '.join(set_clauses)} WHERE id IN ({placeholders})",
            params,
        )
        updated_count: int = cursor.rowcount
        conn.commit()
        return jsonify({"success": True, "updated": updated_count})
    except sqlite3.Error as e:
        conn.rollback()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()


@app.route("/api/invoices/bulk-delete", methods=["POST"])
def bulk_delete_invoices() -> ApiResponse:
    """Soft-delete multiple invoices at once."""
    data: Any = request.json
    invoice_ids: list[int] = data.get("ids", [])

    if not invoice_ids:
        return jsonify({"success": False, "error": "Missing ids"}), 400

    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    try:
        placeholders: str = ",".join("?" * len(invoice_ids))
        # Soft delete: set deleted_at timestamp instead of removing from database
        cursor.execute(
            f"UPDATE invoices SET deleted_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
            invoice_ids,
        )
        deleted_count: int = cursor.rowcount
        conn.commit()
        return jsonify({"success": True, "deleted": deleted_count})
    except sqlite3.Error as e:
        conn.rollback()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()


@app.route("/api/stats", methods=["GET"])
def get_stats() -> Response:
    """Return aggregate statistics about invoices with optional date filtering."""
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    date_from: str = request.args.get("date_from", "")
    date_to: str = request.args.get("date_to", "")

    # Build base query conditions
    base_conditions: str = "deleted_at IS NULL"
    params: list[str] = []

    if date_from:
        base_conditions += " AND date >= ?"
        params.append(date_from)
    if date_to:
        base_conditions += " AND date <= ?"
        params.append(date_to)

    # Summary statistics
    cursor.execute(
        f"SELECT COUNT(*) as count, SUM(total) as sum FROM invoices WHERE {base_conditions}",
        params,
    )
    row = cursor.fetchone()
    total_invoices: int = row["count"]
    total_amount: float = row["sum"] or 0

    average_invoice: float = total_amount / total_invoices if total_invoices > 0 else 0

    # Category breakdown
    cursor.execute(
        f"""SELECT COALESCE(category, 'Keine Kategorie') as category,
                   SUM(total) as amount, COUNT(*) as count
            FROM invoices WHERE {base_conditions}
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
            FROM invoices WHERE {base_conditions}
            GROUP BY store ORDER BY amount DESC LIMIT 10""",
        params,
    )
    by_store: list[dict[str, Any]] = [
        {"store": r["store"], "amount": round(r["amount"], 2), "count": r["count"]}
        for r in cursor.fetchall()
    ]

    # Calculate previous period comparison
    comparison: dict[str, Any] = {"previous_total": 0, "change_percent": 0}
    if date_from and date_to:
        try:
            start = datetime.strptime(date_from, "%Y-%m-%d")
            end = datetime.strptime(date_to, "%Y-%m-%d")
            period_days = (end - start).days + 1

            prev_end = start - timedelta(days=1)
            prev_start = prev_end - timedelta(days=period_days - 1)

            cursor.execute(
                "SELECT SUM(total) as sum FROM invoices WHERE deleted_at IS NULL AND date >= ? AND date <= ?",
                (prev_start.strftime("%Y-%m-%d"), prev_end.strftime("%Y-%m-%d")),
            )
            prev_total: float = cursor.fetchone()["sum"] or 0
            comparison["previous_total"] = round(prev_total, 2)

            if prev_total > 0:
                comparison["change_percent"] = round(
                    ((total_amount - prev_total) / prev_total) * 100, 1
                )
        except ValueError:
            pass  # Invalid date format, skip comparison

    conn.close()
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


def main() -> None:
    """Initialize the database and start the Flask development server."""
    app.run(debug=True, port=5000)


# Initialize database on module load (works with gunicorn and dev server)
init_db()

if __name__ == "__main__":
    main()
