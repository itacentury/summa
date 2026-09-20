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


def connect_mirror(database_path: Path) -> sqlite3.Connection:
    """Open a throwaway in-memory copy of a database, for runs that must not write.

    The file itself is only read -- it is not created when missing and its
    journal mode is left alone -- so everything written to the returned
    connection dies with it. This is what lets a dry run report real insert
    counts without a rollback that could never undo the committed schema.

    :param database_path: the SQLite file to copy, ignored when it does not exist.
    """
    mirror: sqlite3.Connection = sqlite3.connect(":memory:")
    if database_path.exists():
        source: sqlite3.Connection = sqlite3.connect(
            f"file:{database_path}?mode=ro", uri=True, timeout=CONNECT_TIMEOUT
        )
        try:
            # backup() replaces the whole target database, so the connection
            # settings below are applied only afterwards.
            source.backup(mirror)
        finally:
            source.close()
    mirror.row_factory = sqlite3.Row
    mirror.execute("PRAGMA foreign_keys = ON")
    create_portfolio_schema(mirror.cursor())
    mirror.commit()
    return mirror
