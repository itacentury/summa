"""Unit tests for the pure derivations in :mod:`summa.portfolio`."""

from datetime import date

import pytest

from summa.portfolio import (
    Depot,
    Position,
    PositionView,
    Snapshot,
    allocation,
    biggest_changes,
    build_depot_views,
    build_position_view,
    build_series,
    build_totals,
    gain,
    gain_pct,
    invested_eur,
    range_start,
    snapshot_dates,
    value_eur,
    week_delta,
)


def _snapshot(
    snapshot_date: str,
    value: float,
    deposit: float = 0.0,
    fx_rate: float = 1.0,
) -> Snapshot:
    """Build a snapshot, defaulting to a EUR position with no deposit."""
    return Snapshot(date=snapshot_date, value=value, deposit=deposit, fx_rate=fx_rate)


def _position(
    position_id: int = 1,
    name: str = "MSCI World SRI",
    snapshots: list[Snapshot] | None = None,
    depot_id: int = 1,
    currency: str = "EUR",
    closed_at: str | None = None,
    sort_order: int = 0,
) -> Position:
    """Build a position with sensible defaults for the field under test."""
    return Position(
        id=position_id,
        depot_id=depot_id,
        name=name,
        kind="etf",
        currency=currency,
        snapshots=snapshots or [],
        closed_at=closed_at,
        sort_order=sort_order,
    )


def _view(
    position_id: int = 1,
    name: str = "Position",
    value: float = 100.0,
    invested: float = 100.0,
    delta: float | None = None,
    closed: bool = False,
    depot_id: int = 1,
    sort_order: int = 0,
) -> PositionView:
    """Build a PositionView directly, for the aggregating functions."""
    return PositionView(
        id=position_id,
        depot_id=depot_id,
        name=name,
        kind="etf",
        currency="EUR",
        is_benchmark_fallback=False,
        is_closed=closed,
        value=value,
        fx_rate=1.0,
        value_eur=value,
        invested_eur=invested,
        gain=value - invested,
        gain_pct=gain_pct(value - invested, invested),
        week_delta=delta,
        first_snapshot_date="2026-01-04",
        last_snapshot_date="2026-03-01",
        snapshot_count=9,
        sort_order=sort_order,
    )


@pytest.mark.parametrize(
    ("value", "fx_rate", "expected"),
    [
        (100.0, 1.0, 100.0),
        (108.0, 1.08, 100.0),
        (0.0, 1.08, 0.0),
        (-50.0, 1.0, -50.0),
    ],
)
def test_value_eur(value: float, fx_rate: float, expected: float) -> None:
    """value_eur divides by the units-per-EUR rate."""
    assert value_eur(value, fx_rate) == pytest.approx(expected)


@pytest.mark.parametrize(
    ("snapshots", "expected"),
    [
        ([], 0.0),
        ([_snapshot("2026-01-04", 100.0, deposit=100.0)], 100.0),
        (
            [
                _snapshot("2026-01-04", 100.0, deposit=100.0),
                _snapshot("2026-01-11", 250.0, deposit=150.0),
            ],
            250.0,
        ),
        ([_snapshot("2026-01-04", 108.0, deposit=108.0, fx_rate=1.08)], 100.0),
        # A negative deposit is a withdrawal and lowers the invested amount.
        (
            [
                _snapshot("2026-01-04", 100.0, deposit=100.0),
                _snapshot("2026-01-11", 60.0, deposit=-40.0),
            ],
            60.0,
        ),
    ],
)
def test_invested_eur(snapshots: list[Snapshot], expected: float) -> None:
    """invested_eur sums every deposit at its own FX rate."""
    assert invested_eur(snapshots) == pytest.approx(expected)


@pytest.mark.parametrize(
    ("value", "invested", "expected_gain", "expected_pct"),
    [
        (110.0, 100.0, 10.0, 10.0),
        (90.0, 100.0, -10.0, -10.0),
        (100.0, 100.0, 0.0, 0.0),
        # Nothing invested: the percentage is undefined, not zero.
        (12.5, 0.0, 12.5, None),
        (0.0, 0.0, 0.0, None),
    ],
)
def test_gain_and_gain_pct(
    value: float, invested: float, expected_gain: float, expected_pct: float | None
) -> None:
    """gain is the plain difference; gain_pct is None without an invested base."""
    absolute: float = gain(value, invested)
    assert absolute == pytest.approx(expected_gain)
    percentage: float | None = gain_pct(absolute, invested)
    if expected_pct is None:
        assert percentage is None
    else:
        assert percentage == pytest.approx(expected_pct)


def test_week_delta_needs_a_previous_week() -> None:
    """A position's first ever snapshot has no delta, not a fabricated one."""
    assert week_delta([]) is None
    assert week_delta([_snapshot("2026-01-04", 1004.0, deposit=1000.0)]) is None


def test_week_delta_does_not_read_a_deposit_as_a_gain() -> None:
    """A week that only grew by its deposit has a delta of zero.

    This is the deliberate difference from the spreadsheet's Delta column.
    """
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 1000.0, deposit=1000.0),
        _snapshot("2026-01-11", 2000.0, deposit=1000.0),
    ]
    assert week_delta(snapshots) == pytest.approx(0.0)


@pytest.mark.parametrize(
    ("latest_value", "latest_deposit", "expected"),
    [
        (1100.0, 0.0, 100.0),
        (900.0, 0.0, -100.0),
        (1200.0, 50.0, 150.0),
    ],
)
def test_week_delta_subtracts_the_latest_deposit(
    latest_value: float, latest_deposit: float, expected: float
) -> None:
    """The delta is the value change minus the money paid in that week."""
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 1000.0),
        _snapshot("2026-01-11", latest_value, deposit=latest_deposit),
    ]
    assert week_delta(snapshots) == pytest.approx(expected)


def test_week_delta_converts_both_weeks_to_eur() -> None:
    """A USD position's delta is computed in EUR, deposit included."""
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 1080.0, fx_rate=1.08),
        _snapshot("2026-01-11", 1188.0, deposit=54.0, fx_rate=1.08),
    ]
    # (1188 - 1080 - 54) / 1.08 = 50
    assert week_delta(snapshots) == pytest.approx(50.0)


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("3m", date(2026, 6, 14)),
        ("1y", date(2025, 9, 14)),
        ("ytd", date(2026, 1, 1)),
        ("max", None),
        ("nonsense", None),
    ],
)
def test_range_start(token: str, expected: date | None) -> None:
    """Each period token maps to its window start; max is unbounded."""
    assert range_start(token, date(2026, 9, 14)) == expected


def test_range_start_clamps_to_a_shorter_month() -> None:
    """Going back from a 31st into a shorter month lands on its last day."""
    assert range_start("3m", date(2026, 5, 31)) == date(2026, 2, 28)


def test_snapshot_dates_is_the_sorted_union_within_the_window() -> None:
    """Dates from all positions are merged, deduplicated and cut at the start."""
    positions: list[Position] = [
        _position(
            1,
            snapshots=[
                _snapshot("2025-12-28", 100.0),
                _snapshot("2026-01-04", 110.0),
            ],
        ),
        _position(
            2,
            snapshots=[
                _snapshot("2026-01-04", 200.0),
                _snapshot("2026-01-11", 210.0),
            ],
        ),
    ]
    assert snapshot_dates(positions, date(2026, 1, 1)) == ["2026-01-04", "2026-01-11"]
    assert snapshot_dates(positions, None) == [
        "2025-12-28",
        "2026-01-04",
        "2026-01-11",
    ]


def test_build_series_sums_positions_per_date() -> None:
    """The portfolio line is the sum of values, the invested line a running sum."""
    positions: list[Position] = [
        _position(
            1,
            snapshots=[
                _snapshot("2026-01-04", 100.0, deposit=100.0),
                _snapshot("2026-01-11", 120.0, deposit=10.0),
            ],
        ),
        _position(
            2,
            snapshots=[
                _snapshot("2026-01-04", 200.0, deposit=200.0),
                _snapshot("2026-01-11", 190.0),
            ],
        ),
    ]
    series = build_series(positions, ["2026-01-04", "2026-01-11"])

    assert series.dates == ["2026-01-04", "2026-01-11"]
    assert series.portfolio == pytest.approx([300.0, 310.0])
    assert series.invested == pytest.approx([300.0, 310.0])


def test_build_series_does_not_start_a_late_position_at_zero() -> None:
    """A position joining mid-period adds nothing before its first snapshot."""
    positions: list[Position] = [
        _position(
            1,
            snapshots=[
                _snapshot("2026-01-04", 100.0, deposit=100.0),
                _snapshot("2026-01-11", 100.0),
                _snapshot("2026-01-18", 100.0),
            ],
        ),
        _position(
            2,
            snapshots=[_snapshot("2026-01-18", 500.0, deposit=500.0)],
        ),
    ]
    series = build_series(positions, ["2026-01-04", "2026-01-11", "2026-01-18"])

    assert series.portfolio == pytest.approx([100.0, 100.0, 600.0])
    assert series.invested == pytest.approx([100.0, 100.0, 600.0])


def test_build_series_carries_a_missing_week_forward() -> None:
    """A date a position has no row for keeps its previous value."""
    positions: list[Position] = [
        _position(
            1,
            snapshots=[
                _snapshot("2026-01-04", 100.0, deposit=100.0),
                _snapshot("2026-01-18", 130.0),
            ],
        ),
        _position(
            2,
            snapshots=[
                _snapshot("2026-01-11", 50.0, deposit=50.0),
            ],
        ),
    ]
    series = build_series(positions, ["2026-01-04", "2026-01-11", "2026-01-18"])

    # Position 1 holds 100 through the week it skipped; position 2 holds 50 after.
    assert series.portfolio == pytest.approx([100.0, 150.0, 180.0])
    assert series.invested == pytest.approx([100.0, 150.0, 150.0])


def test_build_position_view_derives_every_number() -> None:
    """A USD position's view converts value, invested and delta to EUR."""
    position: Position = _position(
        7,
        name="FTSE All-World",
        currency="USD",
        snapshots=[
            _snapshot("2026-01-04", 1080.0, deposit=1080.0, fx_rate=1.08),
            _snapshot("2026-01-11", 1188.0, deposit=54.0, fx_rate=1.08),
        ],
    )
    view = build_position_view(position)

    assert view.value == pytest.approx(1188.0)
    assert view.value_eur == pytest.approx(1100.0)
    assert view.invested_eur == pytest.approx(1050.0)
    assert view.gain == pytest.approx(50.0)
    assert view.gain_pct == pytest.approx(50.0 / 1050.0 * 100)
    assert view.week_delta == pytest.approx(50.0)
    assert view.first_snapshot_date == "2026-01-04"
    assert view.last_snapshot_date == "2026-01-11"
    assert view.snapshot_count == 2
    assert view.is_closed is False


def test_build_position_view_without_snapshots() -> None:
    """A position that has never been snapshotted is all zeros and Nones."""
    view = build_position_view(_position(3, name="Fresh"))

    assert view.value_eur == 0.0
    assert view.invested_eur == 0.0
    assert view.gain_pct is None
    assert view.week_delta is None
    assert view.first_snapshot_date is None
    assert view.snapshot_count == 0


def test_build_position_view_marks_a_closed_position() -> None:
    """closed_at makes the view report the position as closed."""
    position: Position = _position(
        4, closed_at="2026-02-01", snapshots=[_snapshot("2026-01-04", 10.0)]
    )
    assert build_position_view(position).is_closed is True


def test_build_depot_views_groups_and_subtotals() -> None:
    """Positions land under their depot with a subtotal, depots in sort order."""
    depots: list[Depot] = [
        Depot(id=2, name="Deka", sort_order=1),
        Depot(id=1, name="Trade Republic", sort_order=0),
    ]
    views: list[PositionView] = [
        _view(1, name="B", value=200.0, invested=150.0, depot_id=1, sort_order=1),
        _view(2, name="A", value=100.0, invested=100.0, depot_id=1, sort_order=0),
        _view(3, name="C", value=300.0, invested=400.0, depot_id=2),
    ]
    depot_views = build_depot_views(depots, views)

    assert [depot.name for depot in depot_views] == ["Trade Republic", "Deka"]
    assert [position.name for position in depot_views[0].positions] == ["A", "B"]
    assert depot_views[0].value_eur == pytest.approx(300.0)
    assert depot_views[0].invested_eur == pytest.approx(250.0)
    assert depot_views[0].gain == pytest.approx(50.0)
    assert depot_views[1].gain == pytest.approx(-100.0)


def test_build_depot_views_keeps_an_empty_depot() -> None:
    """A depot without positions still appears, with a zero subtotal."""
    depot_views = build_depot_views([Depot(id=1, name="Deka")], [])

    assert len(depot_views) == 1
    assert depot_views[0].positions == []
    assert depot_views[0].value_eur == 0.0
    assert depot_views[0].gain_pct is None


def test_build_totals_sums_values_and_known_deltas() -> None:
    """The grand total adds every position; a missing delta counts as nothing."""
    views: list[PositionView] = [
        _view(1, value=1000.0, invested=900.0, delta=25.0),
        _view(2, value=500.0, invested=600.0, delta=-5.0),
        _view(3, value=200.0, invested=200.0, delta=None),
    ]
    totals = build_totals(views, depot_count=2)

    assert totals.value_eur == pytest.approx(1700.0)
    assert totals.invested_eur == pytest.approx(1700.0)
    assert totals.gain == pytest.approx(0.0)
    assert totals.week_delta == pytest.approx(20.0)
    assert totals.position_count == 3
    assert totals.depot_count == 2
    assert totals.last_snapshot_date == "2026-03-01"


def test_build_totals_counts_only_held_positions() -> None:
    """A closed position still carries value but is not counted as held."""
    views: list[PositionView] = [
        _view(1, value=1000.0, invested=800.0),
        _view(2, value=300.0, invested=300.0, closed=True),
    ]
    totals = build_totals(views, depot_count=1)

    assert totals.value_eur == pytest.approx(1300.0)
    assert totals.position_count == 1


def test_allocation_excludes_closed_positions_but_totals_keep_them() -> None:
    """A sold position leaves the donut while still counting in the grand total."""
    views: list[PositionView] = [
        _view(1, name="Held", value=750.0, invested=700.0),
        _view(2, name="Sold", value=250.0, invested=250.0, closed=True),
    ]
    slices = allocation(views)

    assert [allocation_slice.label for allocation_slice in slices] == ["Held"]
    assert slices[0].share_pct == pytest.approx(100.0)
    assert build_totals(views, depot_count=1).value_eur == pytest.approx(1000.0)


def test_allocation_pools_the_remainder_into_one_slice() -> None:
    """Nine positions yield five named slices plus one aggregating the other four."""
    views: list[PositionView] = [
        _view(index, name=f"P{index}", value=float(100 - index * 5))
        for index in range(1, 10)
    ]
    slices = allocation(views)

    assert len(slices) == 6
    assert [allocation_slice.aggregated_count for allocation_slice in slices] == [
        0,
        0,
        0,
        0,
        0,
        4,
    ]
    assert slices[-1].label == "4 more"
    assert sum(allocation_slice.share_pct for allocation_slice in slices) == (
        pytest.approx(100.0)
    )
    # Slices come back largest first.
    shares = [allocation_slice.share_pct for allocation_slice in slices[:5]]
    assert shares == sorted(shares, reverse=True)


def test_allocation_without_value_is_empty() -> None:
    """No held value means no donut at all, rather than a division by zero."""
    assert allocation([]) == []
    assert allocation([_view(1, value=0.0, invested=0.0)]) == []


def test_biggest_changes_returns_top_three_per_side() -> None:
    """Gainers and losers are capped at three and ordered by magnitude."""
    views: list[PositionView] = [
        _view(1, name="G1", delta=10.0),
        _view(2, name="G2", delta=40.0),
        _view(3, name="G3", delta=20.0),
        _view(4, name="G4", delta=30.0),
        _view(5, name="L1", delta=-15.0),
        _view(6, name="L2", delta=-5.0),
    ]
    gainers, losers = biggest_changes(views)

    assert [change.name for change in gainers] == ["G2", "G4", "G3"]
    assert [change.name for change in losers] == ["L1", "L2"]


def test_biggest_changes_skips_flat_and_unknown_deltas() -> None:
    """A flat position and one without a previous week are not movers."""
    views: list[PositionView] = [
        _view(1, name="Flat", delta=0.0),
        _view(2, name="New", delta=None),
        _view(3, name="Mover", delta=7.5),
    ]
    gainers, losers = biggest_changes(views)

    assert [change.name for change in gainers] == ["Mover"]
    assert losers == []
