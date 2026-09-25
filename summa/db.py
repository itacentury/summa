"""Database connection management and schema initialization."""

import logging
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Final

from summa.helpers import Invoice, InvoiceItem

logger: logging.Logger = logging.getLogger(__name__)

DATABASE: Final[str] = os.environ.get("DATABASE_PATH", "invoices.db")


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


def insert_invoice(cursor: sqlite3.Cursor, invoice: Invoice) -> int | None:
    """Insert an invoice together with its line items and return the new id."""
    cursor.execute(
        "INSERT INTO invoices (date, store, category, total) VALUES (?, ?, ?, ?)",
        (invoice.date, invoice.store, invoice.category, invoice.total),
    )
    invoice_id: int | None = cursor.lastrowid
    insert_invoice_items(cursor, invoice_id, invoice.items)
    return invoice_id


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

    # A sale is recorded, not flagged: closed_at drives a closing row derived on
    # read (summa.portfolio.with_sale_recorded), never stored, so reopening is
    # lossless. No soft delete here, hence no "deleted_at IS NULL" filter.
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

    # Amounts are in the position's currency; fx_rate = units of it per EUR.
    # deposit is signed (withdrawals, sales), so only value has a floor.
    # carried = 1: value copied forward from the previous week, not entered.
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
    # Partial: list and allocation queries only look at active positions.
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_portfolio_positions_depot "
        "ON portfolio_positions (depot_id) WHERE closed_at IS NULL"
    )


# Columns added to `invoices` after its first release, with the DDL that adds them.
_INVOICE_COLUMN_MIGRATIONS: Final[tuple[tuple[str, str], ...]] = (
    ("deleted_at", "ALTER TABLE invoices ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL"),
    ("category", "ALTER TABLE invoices ADD COLUMN category TEXT DEFAULT NULL"),
)


def _migrate_invoice_columns(cursor: sqlite3.Cursor) -> None:
    """Add every column from the migration table that the database still lacks."""
    cursor.execute("PRAGMA table_info(invoices)")
    columns: set[str] = {column[1] for column in cursor.fetchall()}
    for column, ddl in _INVOICE_COLUMN_MIGRATIONS:
        if column in columns:
            continue
        cursor.execute(ddl)
        logger.info("Migration applied: added '%s' column", column)


def _create_schema(cursor: sqlite3.Cursor) -> None:
    """Create every table and index, migrating older databases on the way."""
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

    _migrate_invoice_columns(cursor)

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


def init_db() -> None:
    """Initialize the database schema and apply migrations if needed."""
    with db_cursor() as cursor:
        _create_schema(cursor)
    logger.info("Database initialized successfully")
