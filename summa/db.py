"""Database connection management and schema initialization."""

import logging
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Final

from summa.helpers import InvoiceItem

logger: logging.Logger = logging.getLogger(__name__)

DATABASE: Final[str] = os.environ.get("DATABASE_PATH", "invoices.db")
LEGACY_PLACEHOLDER_ITEM_NAME: Final[str] = "Placeholder"


def get_db() -> sqlite3.Connection:
    """Create and return a database connection with WAL mode and foreign keys on."""
    conn: sqlite3.Connection = sqlite3.connect(DATABASE, timeout=30.0)
    conn.row_factory = sqlite3.Row
    # Enable WAL mode for better concurrency
    conn.execute("PRAGMA journal_mode=WAL")
    # Foreign keys are off by default in SQLite and the setting is per connection,
    # so without this every ON DELETE CASCADE in the schema is mere documentation.
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db_cursor() -> Iterator[sqlite3.Cursor]:
    """Yield a cursor, committing on success and rolling back on error."""
    conn: sqlite3.Connection = get_db()
    try:
        cursor: sqlite3.Cursor = conn.cursor()
        yield cursor
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def insert_invoice_items(
    cursor: sqlite3.Cursor, invoice_id: int | None, items: list[InvoiceItem]
) -> None:
    """Insert all line items for an invoice."""
    cursor.executemany(
        "INSERT INTO invoice_items (invoice_id, item_name, item_price) VALUES (?, ?, ?)",
        [(invoice_id, item.item_name, item.item_price) for item in items],
    )


def placeholders_for(count: int) -> str:
    """Return a comma-separated list of `count` SQL placeholders."""
    return ",".join("?" * count)


# Safe batch size below the legacy SQLite SQLITE_MAX_VARIABLE_NUMBER (999, pre-3.32).
SQLITE_MAX_VARIABLES: Final[int] = 900


def chunked(items: list[int], size: int = SQLITE_MAX_VARIABLES) -> Iterator[list[int]]:
    """Yield successive `size`-length chunks of `items`."""
    for start in range(0, len(items), size):
        yield items[start : start + size]


def create_portfolio_schema(cursor: sqlite3.Cursor) -> None:
    """Create the portfolio tables and their indexes if they do not exist yet."""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS portfolio_depots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """
    )

    # closed_at marks a sold position, and the sale is recorded rather than just
    # flagged: a closed position's history ends in a snapshot dated exactly
    # closed_at, worth 0 with a deposit of minus the proceeds. That row is derived
    # on every read (summa.portfolio.with_sale_recorded), never stored, so closing
    # and reopening only move this column and no entered week is ever rewritten.
    # The position leaves the allocation and the totals through its own numbers,
    # while keeping its history and its realized gain. Portfolio rows are not
    # soft-deleted, so the invoice-side "deleted_at IS NULL" read filter has no
    # counterpart here.
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS portfolio_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            depot_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('etf', 'fund', 'stock')),
            currency TEXT NOT NULL DEFAULT 'EUR',
            is_benchmark_fallback INTEGER NOT NULL DEFAULT 0
                CHECK (is_benchmark_fallback IN (0, 1)),
            closed_at TEXT DEFAULT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (depot_id) REFERENCES portfolio_depots (id) ON DELETE CASCADE,
            UNIQUE (depot_id, name)
        )
    """
    )

    # value and deposit are in the position's own currency; fx_rate holds the units
    # of that currency per EUR at that date. Only value has a floor: a deposit is a
    # signed flow and goes negative on a withdrawal or a sale, while what a position
    # is worth cannot. carried = 1 means the value was copied
    # forward from the previous week rather than entered by the user. The weekly
    # delta is always derived from consecutive snapshots, never stored.
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS portfolio_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            position_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            value REAL NOT NULL CHECK (value >= 0),
            deposit REAL NOT NULL DEFAULT 0,
            fx_rate REAL NOT NULL DEFAULT 1.0 CHECK (fx_rate > 0),
            carried INTEGER NOT NULL DEFAULT 0 CHECK (carried IN (0, 1)),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (position_id) REFERENCES portfolio_positions (id) ON DELETE CASCADE,
            UNIQUE (position_id, date)
        )
    """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS benchmark_prices (
            symbol TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL NOT NULL,
            PRIMARY KEY (symbol, date)
        )
    """
    )

    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_position_date "
        "ON portfolio_snapshots (position_id, date)"
    )
    # Partial, because every list and allocation query looks at active positions only.
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_portfolio_positions_depot "
        "ON portfolio_positions (depot_id) WHERE closed_at IS NULL"
    )


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

    # Per-invoice cache of AI category suggestions. Keyed by invoice_id (one
    # suggestion per invoice); the fingerprint captures the invoice content the
    # model saw, so an edit invalidates the entry, and the model is stored so a
    # model switch re-checks. category may be NULL (the model returned none) and
    # is cached as such to avoid re-asking. Rows are pruned via ON DELETE CASCADE
    # on hard delete; soft-deleted invoices are excluded by the read filter.
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS invoice_category_suggestions (
            invoice_id INTEGER PRIMARY KEY,
            category TEXT,
            model TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
            logger.info("Migration applied: added 'deleted_at' column")
        except sqlite3.OperationalError:
            logger.debug("Column 'deleted_at' already exists, skipping migration")

    if "category" not in columns:
        try:
            cursor.execute("ALTER TABLE invoices ADD COLUMN category TEXT DEFAULT NULL")
            logger.info("Migration applied: added 'category' column")
        except sqlite3.OperationalError:
            logger.debug("Column 'category' already exists, skipping migration")

    # Indexes for the invoice list access pattern. The invoices indexes are
    # partial (deleted_at IS NULL) because every read filters out soft-deleted
    # rows, which keeps them small and aligned with the actual WHERE/ORDER BY.
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id "
        "ON invoice_items (invoice_id)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_invoices_active_date "
        "ON invoices (date) WHERE deleted_at IS NULL"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_invoices_active_store "
        "ON invoices (store) WHERE deleted_at IS NULL"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_invoices_active_category "
        "ON invoices (category) WHERE deleted_at IS NULL"
    )

    create_portfolio_schema(cursor)

    # Backfill legacy active invoices that predate the items constraint.
    cursor.execute(
        "INSERT INTO invoice_items (invoice_id, item_name, item_price) "
        "SELECT invoices.id, ?, invoices.total "
        "FROM invoices "
        "WHERE invoices.deleted_at IS NULL "
        "AND NOT EXISTS ("
        "SELECT 1 FROM invoice_items WHERE invoice_items.invoice_id = invoices.id"
        ")",
        (LEGACY_PLACEHOLDER_ITEM_NAME,),
    )
    backfilled_items: int = cursor.rowcount if cursor.rowcount != -1 else 0
    if backfilled_items:
        logger.info(
            "Migration applied: backfilled %d placeholder invoice items",
            backfilled_items,
        )

    conn.commit()
    conn.close()
    logger.info("Database initialized successfully")
