"""Database access shared by the operational portfolio scripts."""

import os
import sqlite3
from pathlib import Path
from typing import Final

from summa.db import create_portfolio_schema

CONNECT_TIMEOUT: Final[float] = 30.0


def default_database_path() -> Path:
    """Return the database the app itself would use."""
    return Path(os.environ.get("DATABASE_PATH", "invoices.db"))


def connect(database_path: Path) -> sqlite3.Connection:
    """Open a database with foreign keys on and the portfolio schema present.

    The scripts deliberately do not reuse :func:`summa.db.get_db`: its path is a
    module-level constant read at import, while a CLI takes its target from
    ``--db``. :func:`summa.db.init_db` is avoided for the same reason, and
    because creating the invoice tables is none of these scripts' business.

    :param database_path: the SQLite file to open, created when missing.
    """
    conn: sqlite3.Connection = sqlite3.connect(database_path, timeout=CONNECT_TIMEOUT)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    create_portfolio_schema(conn.cursor())
    conn.commit()
    return conn
