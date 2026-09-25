"""Tests for schema creation, migrations and connection setup in :mod:`summa.db`."""

import sqlite3
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import pytest

from summa import config, db


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    """Return the column names of ``table`` via PRAGMA table_info."""
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return [row[1] for row in cursor.fetchall()]


@pytest.fixture
def temp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point summa.db at a fresh, empty database file for the duration of a test."""
    db_path: Path = tmp_path / "schema.db"
    monkeypatch.setenv(config.DATABASE_PATH_ENV, str(db_path))
    return db_path


def test_init_db_creates_tables(temp_db: Path) -> None:
    """init_db creates both tables with the expected columns."""
    db.init_db()

    conn = db.get_db()
    try:
        invoice_columns: list[str] = _columns(conn, "invoices")
        item_columns: list[str] = _columns(conn, "invoice_items")
    finally:
        conn.close()

    assert {
        "id",
        "date",
        "store",
        "category",
        "total",
        "created_at",
        "deleted_at",
    } <= set(invoice_columns)
    assert {"id", "invoice_id", "item_name", "item_price"} <= set(item_columns)


def test_init_db_creates_indexes(temp_db: Path) -> None:
    """init_db creates the invoice-list access-pattern indexes."""
    db.init_db()

    conn = db.get_db()
    try:
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
        indexes: set[str] = {row[0] for row in cursor.fetchall()}
    finally:
        conn.close()

    assert {
        "idx_invoice_items_invoice_id",
        "idx_invoices_active_date",
        "idx_invoices_active_store",
        "idx_invoices_active_category",
    } <= indexes


def test_init_db_is_idempotent(temp_db: Path) -> None:
    """Running init_db repeatedly does not raise and keeps the schema stable."""
    db.init_db()
    db.init_db()

    conn = db.get_db()
    try:
        columns: list[str] = _columns(conn, "invoices")
    finally:
        conn.close()

    assert "deleted_at" in columns
    assert "category" in columns


def _create_legacy_invoices() -> None:
    """Create an ``invoices`` table as it looked before deleted_at/category."""
    conn = db.get_db()
    try:
        conn.execute(
            """
            CREATE TABLE invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                store TEXT NOT NULL,
                total REAL NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def test_init_db_migrates_legacy_table(temp_db: Path) -> None:
    """An old invoices table without deleted_at/category gets both columns added."""
    _create_legacy_invoices()

    db.init_db()

    conn = db.get_db()
    try:
        columns: list[str] = _columns(conn, "invoices")
    finally:
        conn.close()

    assert "deleted_at" in columns
    assert "category" in columns


def test_init_db_concurrent_migration_does_not_race(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two workers migrating a legacy table at once both boot (gunicorn, no --preload)."""
    # The unguarded race fails about every other run, so repeat to make it bite.
    for run in range(20):
        monkeypatch.setenv(config.DATABASE_PATH_ENV, str(tmp_path / f"race-{run}.db"))
        _create_legacy_invoices()
        barrier: threading.Barrier = threading.Barrier(2)

        def worker() -> None:
            barrier.wait()
            db.init_db()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures: list[Future[None]] = [pool.submit(worker) for _ in range(2)]
        for future in futures:
            future.result()

        conn = db.get_db()
        try:
            columns: list[str] = _columns(conn, "invoices")
        finally:
            conn.close()
        assert {"deleted_at", "category"} <= set(columns)


def test_get_db_uses_row_factory(temp_db: Path) -> None:
    """get_db returns rows that support mapping-style access by column name."""
    db.init_db()

    conn = db.get_db()
    try:
        conn.execute(
            "INSERT INTO invoices (date, store, total) VALUES (?, ?, ?)",
            ("2024-01-01", "Shop", 9.99),
        )
        conn.commit()
        row = conn.execute("SELECT store, total FROM invoices").fetchone()
    finally:
        conn.close()

    assert row["store"] == "Shop"
    assert row["total"] == 9.99


def test_get_db_enables_wal(temp_db: Path) -> None:
    """get_db enables WAL journal mode on the connection."""
    db.init_db()

    conn = db.get_db()
    try:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    finally:
        conn.close()

    assert mode.lower() == "wal"


def _seed_snapshot(conn: sqlite3.Connection) -> tuple[int, int]:
    """Insert one depot, one position and one snapshot, returning the parent ids."""
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO portfolio_depots (name) VALUES (?)", ("Trade Republic",)
    )
    depot_id: int | None = cursor.lastrowid
    assert depot_id is not None
    cursor.execute(
        "INSERT INTO portfolio_positions (depot_id, name, kind) VALUES (?, ?, ?)",
        (depot_id, "MSCI World SRI", "etf"),
    )
    position_id: int | None = cursor.lastrowid
    assert position_id is not None
    cursor.execute(
        "INSERT INTO portfolio_snapshots (position_id, date, value) VALUES (?, ?, ?)",
        (position_id, "2024-01-07", 1131.16),
    )
    conn.commit()
    return depot_id, position_id


def test_init_db_creates_portfolio_tables(temp_db: Path) -> None:
    """init_db creates the four portfolio tables with the expected columns."""
    db.init_db()

    conn = db.get_db()
    try:
        depot_columns: list[str] = _columns(conn, "portfolio_depots")
        position_columns: list[str] = _columns(conn, "portfolio_positions")
        snapshot_columns: list[str] = _columns(conn, "portfolio_snapshots")
        benchmark_columns: list[str] = _columns(conn, "benchmark_prices")
    finally:
        conn.close()

    assert {"id", "name", "sort_order", "created_at"} <= set(depot_columns)
    assert {
        "id",
        "depot_id",
        "name",
        "kind",
        "currency",
        "is_benchmark_fallback",
        "closed_at",
        "sort_order",
        "created_at",
    } <= set(position_columns)
    assert {
        "id",
        "position_id",
        "date",
        "value",
        "deposit",
        "fx_rate",
        "carried",
        "created_at",
    } <= set(snapshot_columns)
    assert {"symbol", "date", "close"} <= set(benchmark_columns)


def test_init_db_creates_portfolio_indexes(temp_db: Path) -> None:
    """init_db creates the portfolio access-pattern indexes."""
    db.init_db()

    conn = db.get_db()
    try:
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
        indexes: set[str] = {row[0] for row in cursor.fetchall()}
    finally:
        conn.close()

    assert {
        "idx_portfolio_snapshots_position_date",
        "idx_portfolio_positions_depot",
    } <= indexes


@pytest.mark.parametrize(
    ("statement", "parameters"),
    [
        (
            "INSERT INTO portfolio_depots (name) VALUES (?)",
            ("Trade Republic",),
        ),
        (
            "INSERT INTO portfolio_positions (depot_id, name, kind) VALUES (?, ?, ?)",
            (1, "MSCI World SRI", "etf"),
        ),
        (
            "INSERT INTO portfolio_snapshots (position_id, date, value) VALUES (?, ?, ?)",
            (1, "2024-01-07", 900.0),
        ),
    ],
)
def test_portfolio_unique_constraints_reject_duplicates(
    temp_db: Path, statement: str, parameters: tuple[object, ...]
) -> None:
    """Re-inserting a depot name, a depot position or a position date is rejected."""
    db.init_db()

    conn = db.get_db()
    try:
        _seed_snapshot(conn)
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(statement, parameters)
    finally:
        conn.close()


@pytest.mark.parametrize(
    ("statement", "parameters"),
    [
        (
            "INSERT INTO portfolio_positions (depot_id, name, kind) VALUES (?, ?, ?)",
            (1, "Bitcoin", "crypto"),
        ),
        (
            "INSERT INTO portfolio_snapshots (position_id, date, value, fx_rate) "
            "VALUES (?, ?, ?, ?)",
            (1, "2024-01-14", 900.0, 0.0),
        ),
        (
            "INSERT INTO portfolio_snapshots (position_id, date, value, carried) "
            "VALUES (?, ?, ?, ?)",
            (1, "2024-01-14", 900.0, 2),
        ),
        (
            "INSERT INTO portfolio_snapshots (position_id, date, value) VALUES (?, ?, ?)",
            (1, "2024-01-14", -500.0),
        ),
    ],
)
def test_portfolio_check_constraints_reject_invalid_values(
    temp_db: Path, statement: str, parameters: tuple[object, ...]
) -> None:
    """An unknown kind, a non-positive fx_rate, a non-boolean carried and a negative value are rejected."""
    db.init_db()

    conn = db.get_db()
    try:
        _seed_snapshot(conn)
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(statement, parameters)
    finally:
        conn.close()


def test_deleting_depot_cascades_to_positions_and_snapshots(temp_db: Path) -> None:
    """Deleting a depot removes its positions and their snapshots."""
    db.init_db()

    conn = db.get_db()
    try:
        depot_id, _ = _seed_snapshot(conn)
        conn.execute("DELETE FROM portfolio_depots WHERE id = ?", (depot_id,))
        conn.commit()
        positions: int = conn.execute(
            "SELECT COUNT(*) FROM portfolio_positions"
        ).fetchone()[0]
        snapshots: int = conn.execute(
            "SELECT COUNT(*) FROM portfolio_snapshots"
        ).fetchone()[0]
    finally:
        conn.close()

    assert positions == 0
    assert snapshots == 0


def test_get_db_enforces_foreign_keys(temp_db: Path) -> None:
    """get_db turns on foreign key enforcement, without which cascades are inert."""
    db.init_db()

    conn = db.get_db()
    try:
        enabled = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    finally:
        conn.close()

    assert enabled == 1
