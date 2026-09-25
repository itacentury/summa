"""Database access shared by the operational portfolio scripts."""

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol

from summa import config
from summa.db import create_portfolio_schema

CONNECT_TIMEOUT: Final[float] = 30.0


class SnapshotFields(Protocol):
    """The columns of one ``portfolio_snapshots`` row, whatever produced it."""

    @property
    def date(self) -> str: ...

    @property
    def value(self) -> float: ...

    @property
    def deposit(self) -> float: ...

    @property
    def fx_rate(self) -> float: ...

    @property
    def carried(self) -> bool: ...


@dataclass(frozen=True)
class SnapshotWrite:
    """What one position's insert did to the database.

    :param carried: carried-forward rows among those *written*, not pre-existing.
    """

    written: int
    existing: int
    carried: int


def default_database_path() -> Path:
    """Return the database the app itself would use."""
    return config.database_path()


def connect(database_path: Path) -> sqlite3.Connection:
    """Open a database with foreign keys on and the portfolio schema present.

    Not :func:`summa.db.get_db`/:func:`summa.db.init_db`: they fix the path at
    import (a CLI takes ``--db``) and would create the invoice tables too.
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

    The file is only read (never created, journal mode untouched), so a dry run
    reports real counts without a rollback that could not undo the schema commit.
    """
    mirror: sqlite3.Connection = sqlite3.connect(":memory:")
    if database_path.exists():
        source: sqlite3.Connection = sqlite3.connect(
            f"file:{database_path}?mode=ro", uri=True, timeout=CONNECT_TIMEOUT
        )
        try:
            # backup() replaces the whole target, so settings are applied after it.
            source.backup(mirror)
        finally:
            source.close()
    mirror.row_factory = sqlite3.Row
    mirror.execute("PRAGMA foreign_keys = ON")
    create_portfolio_schema(mirror.cursor())
    mirror.commit()
    return mirror


@contextmanager
def open_database(database_path: Path, dry_run: bool) -> Iterator[sqlite3.Cursor]:
    """Yield a cursor in one transaction, committed only when the body succeeds.

    :param dry_run: work on a :func:`connect_mirror` copy, discarded on close.
    """
    conn: sqlite3.Connection = (
        connect_mirror(database_path) if dry_run else connect(database_path)
    )
    try:
        yield conn.cursor()
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def resolve_depot(
    cursor: sqlite3.Cursor, name: str, sort_order: int
) -> tuple[int, bool]:
    """Return a depot's id, creating it when missing.

    ``INSERT OR IGNORE ... RETURNING`` yields no row when it ignores, hence the
    separate lookup.

    :return: the id and whether this call created it.
    """
    cursor.execute(
        "INSERT OR IGNORE INTO portfolio_depots (name, sort_order) VALUES (?, ?)",
        (name, sort_order),
    )
    created: bool = cursor.rowcount == 1
    row: sqlite3.Row = cursor.execute(
        "SELECT id FROM portfolio_depots WHERE name = ?", (name,)
    ).fetchone()
    return int(row["id"]), created


def resolve_position(
    cursor: sqlite3.Cursor,
    depot_id: int,
    name: str,
    kind: str,
    currency: str,
    sort_order: int,
    *,
    is_benchmark_fallback: bool = False,
    closed_at: str | None = None,
) -> tuple[int, bool]:
    """Return a position's id, creating it when missing.

    An existing position is never updated: the UI is allowed to have corrected
    whatever a script wrote first.

    :return: the id and whether this call created it.
    """
    cursor.execute(
        "INSERT OR IGNORE INTO portfolio_positions "
        "(depot_id, name, kind, currency, is_benchmark_fallback, closed_at, sort_order) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            depot_id,
            name,
            kind,
            currency,
            int(is_benchmark_fallback),
            closed_at,
            sort_order,
        ),
    )
    created: bool = cursor.rowcount == 1
    row: sqlite3.Row = cursor.execute(
        "SELECT id FROM portfolio_positions WHERE depot_id = ? AND name = ?",
        (depot_id, name),
    ).fetchone()
    return int(row["id"]), created


def insert_snapshots(
    cursor: sqlite3.Cursor, position_id: int, snapshots: Sequence[SnapshotFields]
) -> SnapshotWrite:
    """Write a position's weeks, leaving any already recorded untouched.

    Rows go in one at a time so ``rowcount`` can tell a write from a conflict;
    ``executemany`` would collapse the two.
    """
    written: int = 0
    carried: int = 0
    for snapshot in snapshots:
        cursor.execute(
            "INSERT OR IGNORE INTO portfolio_snapshots "
            "(position_id, date, value, deposit, fx_rate, carried) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                position_id,
                snapshot.date,
                snapshot.value,
                snapshot.deposit,
                snapshot.fx_rate,
                int(snapshot.carried),
            ),
        )
        if cursor.rowcount == 0:
            continue
        written += 1
        carried += int(snapshot.carried)
    return SnapshotWrite(
        written=written, existing=len(snapshots) - written, carried=carried
    )
