"""Flask web application for managing and analyzing invoices.

Provides REST API endpoints for CRUD operations on invoices,
bulk operations, statistics, and a web interface for visualization.
"""

import os
import sqlite3
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
        cursor.execute(
            "ALTER TABLE invoices ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL"
        )

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


@app.route("/api/invoices", methods=["POST"])
def add_invoice() -> Response:
    """Create a new invoice with its associated items."""
    data: Any = request.json
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    cursor.execute(
        "INSERT INTO invoices (date, store, total) VALUES (?, ?, ?)",
        (data["date"], data["store"], float(data["total"])),
    )
    invoice_id: int | None = cursor.lastrowid

    for item in data.get("items", []):
        cursor.execute(
            "INSERT INTO invoice_items (invoice_id, item_name, item_price) VALUES (?, ?, ?)",
            (invoice_id, item["item_name"], float(item["item_price"])),
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
            # Duplikatsprüfung: Gleiche Kombination aus Datum, Geschäft und Gesamtbetrag
            cursor.execute(
                "SELECT id FROM invoices WHERE date = ? AND store = ? AND total = ?",
                (
                    invoice_data["date"],
                    invoice_data["store"],
                    float(invoice_data["total"]),
                ),
            )
            existing: Any = cursor.fetchone()

            if existing:
                skipped_count += 1
                continue

            cursor.execute(
                "INSERT INTO invoices (date, store, total) VALUES (?, ?, ?)",
                (
                    invoice_data["date"],
                    invoice_data["store"],
                    float(invoice_data["total"]),
                ),
            )
            invoice_id: int | None = cursor.lastrowid

            for item in invoice_data.get("items", []):
                cursor.execute(
                    "INSERT INTO invoice_items "
                    "(invoice_id, item_name, item_price) VALUES (?, ?, ?)",
                    (invoice_id, item["item_name"], float(item["item_price"])),
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
            "UPDATE invoices SET date = ?, store = ?, total = ? WHERE id = ?",
            (data["date"], data["store"], float(data["total"]), invoice_id),
        )

        # Delete existing items
        cursor.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (invoice_id,))

        # Insert new items
        for item in data.get("items", []):
            cursor.execute(
                "INSERT INTO invoice_items (invoice_id, item_name, item_price) VALUES (?, ?, ?)",
                (invoice_id, item["item_name"], float(item["item_price"])),
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
    """Update the store name for multiple invoices at once."""
    data: Any = request.json
    invoice_ids: list[int] = data.get("ids", [])
    new_store: str = data.get("store")

    if not invoice_ids or not new_store:
        return jsonify({"success": False, "error": "Missing ids or store"}), 400

    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    try:
        placeholders: str = ",".join("?" * len(invoice_ids))
        params: list[str | int] = [new_store, *invoice_ids]
        cursor.execute(
            f"UPDATE invoices SET store = ? WHERE id IN ({placeholders})",
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
    """Return aggregate statistics about all active invoices."""
    conn: sqlite3.Connection = get_db()
    cursor: sqlite3.Cursor = conn.cursor()

    # Only count non-deleted invoices
    cursor.execute("SELECT COUNT(*) as count FROM invoices WHERE deleted_at IS NULL")
    total_invoices: int = cursor.fetchone()["count"]

    cursor.execute("SELECT SUM(total) as sum FROM invoices WHERE deleted_at IS NULL")
    total_amount: int = cursor.fetchone()["sum"] or 0

    cursor.execute(
        "SELECT COUNT(DISTINCT store) as count FROM invoices WHERE deleted_at IS NULL"
    )
    unique_stores: int = cursor.fetchone()["count"]

    conn.close()
    return jsonify(
        {
            "total_invoices": total_invoices,
            "total_amount": round(total_amount, 2),
            "unique_stores": unique_stores,
        }
    )


def main() -> None:
    """Initialize the database and start the Flask development server."""
    app.run(debug=True, port=5000)


# Initialize database on module load (works with gunicorn and dev server)
init_db()

if __name__ == "__main__":
    main()
