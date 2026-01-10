import sqlite3

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
DATABASE = "invoices.db"


def get_db():
    conn = sqlite3.connect(DATABASE, timeout=30.0)
    conn.row_factory = sqlite3.Row
    # Enable WAL mode for better concurrency
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_db()
    cursor = conn.cursor()

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
    columns = [column[1] for column in cursor.fetchall()]
    if "deleted_at" not in columns:
        cursor.execute(
            "ALTER TABLE invoices ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL"
        )

    conn.commit()
    conn.close()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/invoices", methods=["GET"])
def get_invoices():
    conn = get_db()
    cursor = conn.cursor()

    # Get filter parameters
    filters = {
        "search": request.args.get("search", ""),
        "store": request.args.get("store", ""),
        "date_from": request.args.get("date_from", ""),
        "date_to": request.args.get("date_to", ""),
        "sort_by": request.args.get("sort_by", "date"),
        "sort_order": request.args.get("sort_order", "desc"),
    }

    # Build query - exclude soft-deleted invoices
    query = "SELECT * FROM invoices WHERE deleted_at IS NULL"
    params = []

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
        order = "DESC" if filters["sort_order"] == "desc" else "ASC"
        query += f" ORDER BY {filters['sort_by']} {order}"

    cursor.execute(query, params)

    result = []
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
def get_stores():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT DISTINCT store FROM invoices WHERE deleted_at IS NULL ORDER BY store"
    )
    stores = [row["store"] for row in cursor.fetchall()]
    conn.close()
    return jsonify(stores)


@app.route("/api/invoices", methods=["POST"])
def add_invoice():
    data = request.json
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        "INSERT INTO invoices (date, store, total) VALUES (?, ?, ?)",
        (data["date"], data["store"], float(data["total"])),
    )
    invoice_id = cursor.lastrowid

    for item in data.get("items", []):
        cursor.execute(
            "INSERT INTO invoice_items (invoice_id, item_name, item_price) VALUES (?, ?, ?)",
            (invoice_id, item["item_name"], float(item["item_price"])),
        )

    conn.commit()
    conn.close()
    return jsonify({"success": True, "id": invoice_id})


@app.route("/api/invoices/import", methods=["POST"])
def import_invoices():
    data = request.json
    conn = get_db()
    cursor = conn.cursor()

    imported_count = 0
    skipped_count = 0

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
            existing = cursor.fetchone()

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
            invoice_id = cursor.lastrowid

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
def update_invoice(invoice_id):
    data = request.json
    conn = get_db()
    cursor = conn.cursor()

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
def delete_invoice(invoice_id):
    conn = get_db()
    cursor = conn.cursor()
    # Soft delete: set deleted_at timestamp instead of removing from database
    cursor.execute(
        "UPDATE invoices SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
        (invoice_id,),
    )
    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/invoices/bulk-update", methods=["PUT"])
def bulk_update_invoices():
    data = request.json
    invoice_ids = data.get("ids", [])
    new_store = data.get("store")

    if not invoice_ids or not new_store:
        return jsonify({"success": False, "error": "Missing ids or store"}), 400

    conn = get_db()
    cursor = conn.cursor()

    try:
        placeholders = ",".join("?" * len(invoice_ids))
        cursor.execute(
            f"UPDATE invoices SET store = ? WHERE id IN ({placeholders})",
            [new_store] + invoice_ids,
        )
        updated_count = cursor.rowcount
        conn.commit()
        return jsonify({"success": True, "updated": updated_count})
    except sqlite3.Error as e:
        conn.rollback()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()


@app.route("/api/invoices/bulk-delete", methods=["POST"])
def bulk_delete_invoices():
    data = request.json
    invoice_ids = data.get("ids", [])

    if not invoice_ids:
        return jsonify({"success": False, "error": "Missing ids"}), 400

    conn = get_db()
    cursor = conn.cursor()

    try:
        placeholders = ",".join("?" * len(invoice_ids))
        # Soft delete: set deleted_at timestamp instead of removing from database
        cursor.execute(
            f"UPDATE invoices SET deleted_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
            invoice_ids,
        )
        deleted_count = cursor.rowcount
        conn.commit()
        return jsonify({"success": True, "deleted": deleted_count})
    except sqlite3.Error as e:
        conn.rollback()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()


@app.route("/api/stats", methods=["GET"])
def get_stats():
    conn = get_db()
    cursor = conn.cursor()

    # Only count non-deleted invoices
    cursor.execute("SELECT COUNT(*) as count FROM invoices WHERE deleted_at IS NULL")
    total_invoices = cursor.fetchone()["count"]

    cursor.execute("SELECT SUM(total) as sum FROM invoices WHERE deleted_at IS NULL")
    total_amount = cursor.fetchone()["sum"] or 0

    cursor.execute(
        "SELECT COUNT(DISTINCT store) as count FROM invoices WHERE deleted_at IS NULL"
    )
    unique_stores = cursor.fetchone()["count"]

    conn.close()
    return jsonify(
        {
            "total_invoices": total_invoices,
            "total_amount": round(total_amount, 2),
            "unique_stores": unique_stores,
        }
    )


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000)
