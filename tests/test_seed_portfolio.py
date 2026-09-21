"""Unit tests for the pure generator in :mod:`scripts.seed_portfolio`.

The generator writes straight to SQLite and so bypasses every check the API
performs on a snapshot. These tests stand in for those checks: they assert the
schema's constraints and the portfolio layer's reading rules against the data
before any of it reaches a database.
"""

import sqlite3
from datetime import date
from pathlib import Path

import pytest

import scripts.seed_portfolio as seed_portfolio
from scripts.seed_portfolio import (
    DEFAULT_SEED,
    DEFAULT_WEEKS,
    SeedData,
    SeedPosition,
    SeedSummary,
    build_seed_data,
    snapshot_range,
    symbol_notes,
    weekly_grid,
    write_seed_data,
)
from summa import config
from summa.db import create_portfolio_schema
from summa.portfolio import (
    Position,
    PositionView,
    Snapshot,
    allocation,
    biggest_changes,
    build_position_view,
    build_totals,
    with_sale_recorded,
)

TODAY: date = date(2026, 9, 21)
VALID_KINDS: frozenset[str] = frozenset({"etf", "fund", "stock"})


@pytest.fixture
def seeded() -> SeedData:
    """The default profile, generated against a fixed date and seed."""
    return build_seed_data(DEFAULT_WEEKS, DEFAULT_SEED, TODAY, "EUNL.DE")


def _to_view(position: SeedPosition, position_id: int) -> PositionView:
    """Run a generated position through the derivations the API would apply."""
    snapshots: list[Snapshot] = [
        Snapshot(
            date=snapshot.date,
            value=snapshot.value,
            deposit=snapshot.deposit,
            fx_rate=snapshot.fx_rate,
            carried=snapshot.carried,
        )
        for snapshot in position.snapshots
    ]
    return build_position_view(
        Position(
            id=position_id,
            depot_id=1,
            name=position.name,
            kind=position.kind,
            currency=position.currency,
            snapshots=with_sale_recorded(snapshots, position.closed_at),
            closed_at=position.closed_at,
        )
    )


def _views(data: SeedData) -> list[PositionView]:
    """Derive every position's displayed numbers, as the API does on read."""
    return [
        _to_view(position, index + 1) for index, position in enumerate(data.positions)
    ]


def test_weekly_grid_ends_on_the_last_monday_before_today() -> None:
    """The API rejects a future snapshot, so the grid must not reach past today."""
    grid: list[str] = weekly_grid(3, date(2026, 9, 24))

    assert grid == ["2026-09-07", "2026-09-14", "2026-09-21"]


def test_weekly_grid_ends_on_today_when_today_is_a_monday() -> None:
    """A Monday is its own week's date, not the previous one's."""
    assert weekly_grid(1, date(2026, 9, 21)) == ["2026-09-21"]


def test_snapshots_are_ascending_and_dated_once(seeded: SeedData) -> None:
    """Every derivation reads a history ascending by date; the schema needs it unique."""
    for position in seeded.positions:
        dates: list[str] = [snapshot.date for snapshot in position.snapshots]

        assert dates == sorted(dates)
        assert len(dates) == len(set(dates))
        assert dates[-1] <= TODAY.isoformat()


def test_snapshots_satisfy_the_schema_checks(seeded: SeedData) -> None:
    """``value >= 0``, ``fx_rate > 0`` and the ``kind`` whitelist are CHECK constraints."""
    for position in seeded.positions:
        assert position.kind in VALID_KINDS
        for snapshot in position.snapshots:
            assert snapshot.value >= 0
            assert snapshot.fx_rate > 0


def test_a_position_starts_with_a_value_it_was_bought_at(seeded: SeedData) -> None:
    """A zero first grid point makes ``rebase_to_grid`` drop the benchmark line.

    The first week is also never carried: there is nothing yet to copy forward.
    """
    for position in seeded.positions:
        first = position.snapshots[0]

        assert first.value > 0
        assert first.deposit > 0
        assert not first.carried


def test_a_carried_week_repeats_the_previous_value_without_a_deposit(
    seeded: SeedData,
) -> None:
    """``carried`` describes the value alone -- money that moved is a recorded week."""
    carried_weeks: int = 0
    for position in seeded.positions:
        for index, snapshot in enumerate(position.snapshots):
            if not snapshot.carried:
                continue
            carried_weeks += 1
            assert snapshot.deposit == 0
            assert snapshot.value == position.snapshots[index - 1].value

    assert carried_weeks > 0


def test_the_sold_position_stores_no_closing_row(seeded: SeedData) -> None:
    """The zeroing row is derived from ``closed_at``, never stored.

    Storing it as well would withdraw the proceeds twice, because
    :func:`summa.portfolio.with_sale_recorded` appends its own on every read.
    """
    closed: list[SeedPosition] = [
        position for position in seeded.positions if position.closed_at is not None
    ]

    assert len(closed) == 1
    position: SeedPosition = closed[0]
    assert position.snapshots[-1].date == position.closed_at
    assert position.snapshots[-1].value > 0
    assert all(snapshot.deposit >= 0 for snapshot in position.snapshots)


def test_exactly_one_position_is_the_benchmark_fallback(seeded: SeedData) -> None:
    """The API allows a single fallback and clears the others when one is set."""
    fallbacks: list[SeedPosition] = [
        position for position in seeded.positions if position.is_benchmark_fallback
    ]

    assert len(fallbacks) == 1
    # The fallback stands in for the whole chart, so it needs the longest history.
    assert len(fallbacks[0].snapshots) == max(
        len(position.snapshots) for position in seeded.positions
    )


def test_names_are_unique_within_their_depot(seeded: SeedData) -> None:
    """``portfolio_depots.name`` and ``(depot_id, name)`` are UNIQUE."""
    depot_names: list[str] = [depot.name for depot in seeded.depots]
    keys: list[tuple[str, str]] = [
        (position.depot, position.name) for position in seeded.positions
    ]

    assert len(depot_names) == len(set(depot_names))
    assert len(keys) == len(set(keys))
    assert {position.depot for position in seeded.positions} == set(depot_names)


def test_the_benchmark_reaches_back_before_the_first_snapshot(
    seeded: SeedData,
) -> None:
    """``_anchor_value`` needs a close at or before the chart's first date.

    Without one the benchmark would be anchored on a point inside the window and
    start somewhere other than the portfolio's own value.
    """
    first_snapshot: str = min(
        position.snapshots[0].date for position in seeded.positions
    )
    dates: list[str] = [price.date for price in seeded.benchmark_prices]

    assert dates == sorted(dates)
    assert dates[0] < first_snapshot
    assert all(price.close > 0 for price in seeded.benchmark_prices)


def test_the_same_seed_yields_the_same_history() -> None:
    """A reproducible screenshot is the reason the generator takes a seed at all."""
    again: SeedData = build_seed_data(DEFAULT_WEEKS, DEFAULT_SEED, TODAY, "EUNL.DE")

    assert again == build_seed_data(DEFAULT_WEEKS, DEFAULT_SEED, TODAY, "EUNL.DE")
    assert again != build_seed_data(DEFAULT_WEEKS, DEFAULT_SEED + 1, TODAY, "EUNL.DE")


def test_a_short_run_still_staggers_the_entries() -> None:
    """Offsets scale with --weeks, so a small run is not eleven positions bought at once."""
    data: SeedData = build_seed_data(12, DEFAULT_SEED, TODAY, "EUNL.DE")
    starts: set[str] = {position.snapshots[0].date for position in data.positions}

    assert len(starts) > 1
    assert all(len(position.snapshots) >= 2 for position in data.positions)


def test_every_position_reports_a_percentage_and_a_weekly_move(
    seeded: SeedData,
) -> None:
    """Both are None-able, and a screen full of blanks proves nothing about the UI."""
    for view in _views(seeded):
        assert view.gain_pct is not None
        assert view.week_delta is not None
        assert view.snapshot_count >= 2


def test_the_portfolio_fills_the_donut_and_both_mover_lists(seeded: SeedData) -> None:
    """The states the profile exists to show: pooled slices, gainers and losers.

    The movers depend on the last week's shared market factor, so this holds for
    the default seed rather than for every seed -- which is what fixing the seed
    is for.
    """
    views: list[PositionView] = _views(seeded)
    gainers, losers = biggest_changes(views)
    slices = allocation(views)

    assert len(gainers) == 3
    assert len(losers) == 3
    assert len(slices) == 6
    assert slices[-1].aggregated_count == 5


def test_the_totals_read_as_a_real_portfolio(seeded: SeedData) -> None:
    """A sold position drops out of the count but keeps its realized gain in the total."""
    views: list[PositionView] = _views(seeded)
    totals = build_totals(views, len(seeded.depots))

    assert totals.position_count == len(seeded.positions) - 1
    assert totals.depot_count == 3
    assert totals.value_eur > 0
    assert totals.gain_pct is not None
    assert totals.last_snapshot_date == TODAY.isoformat()
    # Both signs are represented, so the UI shows its gain and its loss styling.
    assert min(view.gain for view in views) < 0 < max(view.gain for view in views)


# --- Writing and the command line -------------------------------------------


def _memory_database() -> sqlite3.Connection:
    """Return an in-memory database carrying the portfolio schema."""
    conn: sqlite3.Connection = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_portfolio_schema(conn.cursor())
    return conn


def test_the_reported_range_spans_every_position(seeded: SeedData) -> None:
    """The roster's order must not decide what the run reports it covered."""
    reported: tuple[str, str] = snapshot_range(seeded.positions)

    assert reported == snapshot_range(list(reversed(seeded.positions)))
    assert reported[0] == min(
        position.snapshots[0].date for position in seeded.positions
    )
    assert reported[1] == max(
        position.snapshots[-1].date for position in seeded.positions
    )


def test_the_summary_counts_carried_rows_it_wrote(seeded: SeedData) -> None:
    """Every line of the summary reports the database, not the generated data.

    A re-run writes nothing, so it must not go on claiming carried rows either.
    """
    conn: sqlite3.Connection = _memory_database()
    cursor: sqlite3.Cursor = conn.cursor()

    first: SeedSummary = write_seed_data(cursor, seeded, reset=False)
    again: SeedSummary = write_seed_data(cursor, seeded, reset=False)

    assert 0 < first.rows_carried <= first.snapshots_written
    assert again.snapshots_written == 0
    assert again.rows_carried == 0
    assert again.snapshots_existing == first.snapshots_written


def test_a_matching_symbol_is_not_worth_a_note() -> None:
    """The default run seeds what the chart reads; a note then says nothing."""
    assert symbol_notes("EUNL.DE", "EUNL.DE", reset=True, dry_run=False) == []


def test_a_foreign_symbol_is_reported_and_reset_names_its_extra_cost() -> None:
    """--reset clears benchmark_prices, so a mistyped symbol leaves no closes at all."""
    plain: list[str] = symbol_notes("SPY", "EUNL.DE", reset=False, dry_run=False)
    with_reset: list[str] = symbol_notes("SPY", "EUNL.DE", reset=True, dry_run=False)

    assert len(plain) == 1
    assert "SPY" in plain[0] and "EUNL.DE" in plain[0]
    assert len(with_reset) == 2
    assert "--reset" in with_reset[1]


def test_a_dry_run_does_not_claim_a_deletion_it_never_made() -> None:
    """--dry-run writes into a mirror, so nothing on disk was cleared."""
    notes: list[str] = symbol_notes("SPY", "EUNL.DE", reset=True, dry_run=True)

    assert "would clear" in notes[1]


def test_main_warns_before_seeding_a_foreign_symbol(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Seeding another ticker is allowed — it just no longer happens silently."""
    monkeypatch.setenv(config.BENCHMARK_SYMBOL_ENV, "EUNL.DE")
    database: Path = tmp_path / "seed.db"

    exit_code: int = seed_portfolio.main(
        ["--db", str(database), "--weeks", "12", "--symbol", "SPY", "--reset"]
    )

    assert exit_code == 0
    errors: str = capsys.readouterr().err
    assert "SPY" in errors
    assert "EUNL.DE" in errors
    assert "--reset" in errors
