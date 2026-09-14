"""Unit tests for the pure derivations in :mod:`summa.portfolio`."""

from datetime import date

import pytest

from summa.portfolio import (
    ChartWindow,
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
    chart_window,
    contributed_eur,
    gain,
    gain_pct,
    growth_points,
    invested_eur,
    range_start,
    rebase_to_grid,
    snapshot_dates,
    value_eur,
    week_delta,
    with_sale_recorded,
)


def _snapshot(
    snapshot_date: str,
    value: float,
    deposit: float = 0.0,
    fx_rate: float = 1.0,
) -> Snapshot:
    """Build a snapshot, defaulting to a EUR position with no deposit."""
    return Snapshot(date=snapshot_date, value=value, deposit=deposit, fx_rate=fx_rate)


def test_with_sale_recorded_leaves_an_open_position_alone() -> None:
    """Without a close date there is no sale to record."""
    snapshots: list[Snapshot] = [_snapshot("2026-01-04", 1000.0, deposit=1000.0)]

    assert with_sale_recorded(snapshots, None) == snapshots


def test_with_sale_recorded_has_nothing_to_take_out_of_an_unsnapshotted_position() -> (
    None
):
    """A position that was never recorded holds no value to withdraw."""
    assert with_sale_recorded([], "2026-01-11") == []
    assert with_sale_recorded([_snapshot("2026-01-18", 500.0)], "2026-01-11") == []


def test_with_sale_recorded_appends_the_sale_after_the_last_week() -> None:
    """Selling in a week not yet recorded takes the last known value back out."""
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 900.0, deposit=1000.0),
        _snapshot("2026-01-11", 1080.0, fx_rate=1.08),
    ]

    result = list(with_sale_recorded(snapshots, "2026-01-18"))

    assert result[:2] == snapshots
    assert result[-1] == Snapshot(
        date="2026-01-18",
        value=0.0,
        deposit=-1080.0,
        fx_rate=1.08,
        carried=False,
        derived=True,
    )


def test_with_sale_recorded_follows_the_week_it_was_sold_in() -> None:
    """The week the sale fell in stays standing, the sale is its own row.

    Netting the two into one row would subtract that week's deposit from itself
    and hide it from contributed_eur, which only counts money paid in.
    """
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 400.0, deposit=400.0),
        _snapshot("2026-01-11", 500.0, deposit=50.0),
    ]

    result = list(with_sale_recorded(snapshots, "2026-01-11"))

    assert result[:2] == snapshots
    assert result[-1] == Snapshot(
        date="2026-01-11", value=0.0, deposit=-500.0, derived=True
    )


def test_with_sale_recorded_drops_weeks_after_the_close() -> None:
    """A snapshot dated after the sale would revive a position already sold."""
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 500.0, deposit=500.0),
        _snapshot("2026-01-18", 520.0),
    ]

    result = list(with_sale_recorded(snapshots, "2026-01-11"))

    assert [snapshot.date for snapshot in result] == ["2026-01-04", "2026-01-11"]
    assert result[-1].deposit == -500.0


def test_with_sale_recorded_never_marks_the_sale_as_carried() -> None:
    """The closing row is computed, not a value copied forward from last week."""
    snapshots: list[Snapshot] = [
        Snapshot(date="2026-01-11", value=500.0, deposit=0.0, carried=True)
    ]

    assert with_sale_recorded(snapshots, "2026-01-11")[-1].carried is False
    assert with_sale_recorded(snapshots, "2026-01-18")[-1].carried is False


def test_with_sale_recorded_flags_only_the_sale_row_as_derived() -> None:
    """The closing row is the one row the user never recorded."""
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 400.0, deposit=400.0),
        _snapshot("2026-01-11", 500.0),
    ]

    result = list(with_sale_recorded(snapshots, "2026-01-11"))

    assert [snapshot.derived for snapshot in result] == [False, False, True]


def test_with_sale_recorded_does_not_mutate_its_input() -> None:
    """Deriving the sale must leave the stored history untouched."""
    snapshots: list[Snapshot] = [_snapshot("2026-01-11", 500.0, deposit=50.0)]

    with_sale_recorded(snapshots, "2026-01-11")

    assert snapshots == [_snapshot("2026-01-11", 500.0, deposit=50.0)]


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
    contributed: float | None = None,
    delta: float | None = None,
    closed_at: str | None = None,
    depot_id: int = 1,
    sort_order: int = 0,
) -> PositionView:
    """Build a PositionView directly, for the aggregating functions.

    :param contributed: defaults to `invested`, which is what they are equal to
        for any position that was never sold from.
    """
    if contributed is None:
        contributed = invested
    return PositionView(
        id=position_id,
        depot_id=depot_id,
        name=name,
        kind="etf",
        currency="EUR",
        is_benchmark_fallback=False,
        closed_at=closed_at,
        value=value,
        fx_rate=1.0,
        value_eur=value,
        invested_eur=invested,
        contributed_eur=contributed,
        gain=value - invested,
        gain_pct=gain_pct(value - invested, contributed),
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


def test_contributed_eur_ignores_a_withdrawal() -> None:
    """Only money paid in counts towards the gain_pct basis."""
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 250.0, deposit=250.0),
        _snapshot("2026-01-11", 0.0, deposit=-300.0),
    ]
    assert contributed_eur(snapshots) == pytest.approx(250.0)
    assert invested_eur(snapshots) == pytest.approx(-50.0)


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


def test_week_delta_of_a_sale_is_zero() -> None:
    """Selling is neither a gain nor a loss: the deposit subtraction cancels it."""
    snapshots: list[Snapshot] = [
        _snapshot("2026-01-04", 300.0),
        _snapshot("2026-01-11", 0.0, deposit=-300.0),
    ]
    assert week_delta(snapshots) == pytest.approx(0.0)


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


TODAY: date = date(2026, 9, 14)


@pytest.mark.parametrize(
    ("token", "expected_start"),
    [
        ("3m", "2026-06-14"),
        ("1y", "2025-09-14"),
        ("ytd", "2026-01-01"),
    ],
)
def test_chart_window_spans_the_period_not_the_data(
    token: str, expected_start: str
) -> None:
    """A bounded window starts at the period start even when the data starts later."""
    window: ChartWindow = chart_window(token, TODAY, ["2026-08-30", "2026-09-06"])
    assert window.start == expected_start
    assert window.end == "2026-09-14"


def test_chart_window_starts_at_the_first_date_for_max() -> None:
    """Max has no computable start, so the first date with data is the boundary."""
    window: ChartWindow = chart_window("max", TODAY, ["2024-03-02", "2026-09-06"])
    assert window.start == "2024-03-02"


def test_chart_window_without_data_has_no_start_for_max() -> None:
    """Neither a period start nor a first date exists — the axis is undefined."""
    window: ChartWindow = chart_window("max", TODAY, [])
    assert window.start is None
    assert window.end == "2026-09-14"


def test_chart_window_without_data_keeps_the_period_start() -> None:
    """An empty portfolio still draws the selected period, just without a line."""
    window: ChartWindow = chart_window("3m", TODAY, [])
    assert window.start == "2026-06-14"
    assert window.end == "2026-09-14"


def test_chart_window_ends_after_a_future_dated_snapshot() -> None:
    """An imported date past today widens the axis rather than being clipped."""
    window: ChartWindow = chart_window("1y", TODAY, ["2026-09-06", "2026-09-20"])
    assert window.end == "2026-09-20"


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


def test_build_series_steps_down_when_a_position_is_sold() -> None:
    """Both lines drop on the sale date: the money left the portfolio."""
    positions: list[Position] = [
        _position(
            1,
            name="Sold",
            closed_at="2026-01-18",
            snapshots=[
                _snapshot("2026-01-04", 100.0, deposit=100.0),
                _snapshot("2026-01-18", 0.0, deposit=-120.0),
            ],
        ),
        _position(
            2,
            name="Held",
            snapshots=[_snapshot("2026-01-04", 500.0, deposit=500.0)],
        ),
    ]
    series = build_series(positions, ["2026-01-04", "2026-01-11", "2026-01-18"])

    assert series.portfolio == pytest.approx([600.0, 600.0, 500.0])
    assert series.invested == pytest.approx([600.0, 600.0, 480.0])


def test_build_series_consumes_two_snapshots_sharing_one_date() -> None:
    """A sale following the week it fell in leaves two rows on one grid date.

    Both have to land in the same slot: the value the later one carries, and the
    deposits of both.
    """
    positions: list[Position] = [
        _position(
            1,
            closed_at="2026-01-11",
            snapshots=[
                _snapshot("2026-01-04", 400.0, deposit=400.0),
                _snapshot("2026-01-11", 500.0, deposit=50.0),
                _snapshot("2026-01-11", 0.0, deposit=-500.0),
            ],
        )
    ]

    series = build_series(positions, ["2026-01-04", "2026-01-11"])

    assert series.portfolio == pytest.approx([400.0, 0.0])
    assert series.invested == pytest.approx([400.0, -50.0])


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
    assert view.closed_at is None


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
    assert build_position_view(position).closed_at == "2026-02-01"


def test_build_position_view_of_a_sold_position_keeps_its_realized_gain() -> None:
    """A sale leaves the position worth nothing but reports what it earned.

    gain_pct divides by what was paid in, not by the net invested amount — the
    latter is the negation of the gain here and would read as exactly -100 %.
    """
    position: Position = _position(
        5,
        closed_at="2026-01-11",
        snapshots=[
            _snapshot("2026-01-04", 250.0, deposit=250.0),
            _snapshot("2026-01-11", 0.0, deposit=-300.0),
        ],
    )
    view: PositionView = build_position_view(position)

    assert view.closed_at == "2026-01-11"
    assert view.value_eur == pytest.approx(0.0)
    assert view.invested_eur == pytest.approx(-50.0)
    assert view.contributed_eur == pytest.approx(250.0)
    assert view.gain == pytest.approx(50.0)
    assert view.gain_pct == pytest.approx(20.0)


def test_build_position_view_counts_the_deposit_of_the_week_it_was_sold_in() -> None:
    """Selling in a week that was paid into must not drop that deposit.

    Through with_sale_recorded rather than a hand-built history: the sale row
    sharing its date with a stored one is exactly what is under test.
    """
    stored: list[Snapshot] = [
        _snapshot("2026-01-04", 400.0, deposit=400.0),
        _snapshot("2026-01-11", 500.0, deposit=50.0),
    ]
    position: Position = _position(
        6,
        closed_at="2026-01-11",
        snapshots=list(with_sale_recorded(stored, "2026-01-11")),
    )

    view: PositionView = build_position_view(position)

    assert view.value_eur == pytest.approx(0.0)
    assert view.invested_eur == pytest.approx(-50.0)
    assert view.contributed_eur == pytest.approx(450.0)
    assert view.gain == pytest.approx(50.0)
    assert view.gain_pct == pytest.approx(50.0 / 450.0 * 100)


def test_build_position_view_counts_only_the_weeks_that_were_recorded() -> None:
    """The derived closing row is not a week the user ever entered.

    Both cases go through with_sale_recorded: selling in a week of its own and
    selling in a week already recorded append the same single derived row.
    """
    stored: list[Snapshot] = [
        _snapshot("2026-01-04", 400.0, deposit=400.0),
        _snapshot("2026-01-11", 500.0, deposit=50.0),
    ]

    sold_later: Position = _position(
        8,
        closed_at="2026-01-18",
        snapshots=list(with_sale_recorded(stored, "2026-01-18")),
    )
    sold_that_week: Position = _position(
        9,
        closed_at="2026-01-11",
        snapshots=list(with_sale_recorded(stored, "2026-01-11")),
    )

    assert build_position_view(sold_later).snapshot_count == 2
    assert build_position_view(sold_that_week).snapshot_count == 2


def test_build_position_view_of_a_position_sold_before_it_was_snapshotted() -> None:
    """Without a value to withdraw there is no closing row, and nothing to count."""
    position: Position = _position(10, closed_at="2026-01-11")

    assert build_position_view(position).snapshot_count == 0


def test_build_position_view_of_a_position_bought_and_sold_in_one_week() -> None:
    """Its only deposit is the close week's, so it is the whole basis.

    Netting that deposit away would leave nothing contributed and turn gain_pct
    into None — the undefined percentage the contributed basis exists to avoid.
    """
    stored: list[Snapshot] = [_snapshot("2026-01-11", 500.0, deposit=500.0)]
    position: Position = _position(
        7,
        closed_at="2026-01-11",
        snapshots=list(with_sale_recorded(stored, "2026-01-11")),
    )

    view: PositionView = build_position_view(position)

    assert view.invested_eur == pytest.approx(0.0)
    assert view.contributed_eur == pytest.approx(500.0)
    assert view.gain_pct == pytest.approx(0.0)


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
    assert depot_views[0].contributed_eur == pytest.approx(250.0)
    assert depot_views[0].gain == pytest.approx(50.0)
    assert depot_views[1].gain == pytest.approx(-100.0)


def test_build_depot_views_subtotal_keeps_the_contributed_basis() -> None:
    """A sold member pulls the subtotal's net invested below its contributions.

    The two sums stop being equal as soon as money was taken out, and gain_pct
    stays measured against what was paid in — dividing by the net amount would
    report 100 % here instead of 14.29 %.
    """
    views: list[PositionView] = [
        _view(1, name="Held", value=100.0, invested=100.0),
        _view(
            2,
            name="Sold",
            value=0.0,
            invested=-50.0,
            contributed=250.0,
            closed_at="2026-03-01",
        ),
    ]
    depot_views = build_depot_views([Depot(id=1, name="Trade Republic")], views)

    assert depot_views[0].invested_eur == pytest.approx(50.0)
    assert depot_views[0].contributed_eur == pytest.approx(350.0)
    assert depot_views[0].gain == pytest.approx(50.0)
    assert depot_views[0].gain_pct == pytest.approx(50.0 / 350.0 * 100)


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
    assert totals.contributed_eur == pytest.approx(1700.0)
    assert totals.gain == pytest.approx(0.0)
    assert totals.week_delta == pytest.approx(20.0)
    assert totals.position_count == 3
    assert totals.depot_count == 2
    assert totals.last_snapshot_date == "2026-03-01"


def test_build_totals_counts_only_held_positions() -> None:
    """A sold position is worth nothing and is not counted as held."""
    views: list[PositionView] = [
        _view(1, value=1000.0, invested=800.0),
        _view(2, value=0.0, invested=-50.0, contributed=250.0, closed_at="2026-03-01"),
    ]
    totals = build_totals(views, depot_count=1)

    assert totals.value_eur == pytest.approx(1000.0)
    assert totals.position_count == 1


def test_build_totals_ignores_a_closed_positions_stale_delta() -> None:
    """A position closed by hand keeps its last delta out of "Last week".

    A sale recorded properly already zeroes its own delta; this covers the row
    that was closed without one, which would otherwise report the same week for
    as long as it exists.
    """
    views: list[PositionView] = [
        _view(1, value=1000.0, invested=900.0, delta=25.0),
        _view(2, value=300.0, invested=300.0, delta=400.0, closed_at="2026-03-01"),
    ]
    assert build_totals(views, depot_count=1).week_delta == pytest.approx(25.0)


def test_allocation_and_totals_both_lose_a_sold_position() -> None:
    """A sale takes the money out of the donut and the grand total alike.

    The proceeds left as a negative deposit, so the realized gain survives in
    the total even though the position itself is worth nothing.
    """
    views: list[PositionView] = [
        _view(1, name="Held", value=750.0, invested=700.0),
        _view(
            2,
            name="Sold",
            value=0.0,
            invested=-50.0,
            contributed=250.0,
            closed_at="2026-03-01",
        ),
    ]
    slices = allocation(views)
    totals = build_totals(views, depot_count=1)

    assert [allocation_slice.label for allocation_slice in slices] == ["Held"]
    assert slices[0].share_pct == pytest.approx(100.0)
    assert sum(entry.value_eur for entry in slices) == pytest.approx(totals.value_eur)
    assert totals.value_eur == pytest.approx(750.0)
    assert totals.gain == pytest.approx(100.0)


def test_allocation_excludes_a_position_closed_without_its_zeroing_row() -> None:
    """The closed_at guard still holds for a row closed by hand."""
    views: list[PositionView] = [
        _view(1, name="Held", value=750.0, invested=700.0),
        _view(2, name="Sold", value=250.0, invested=250.0, closed_at="2026-03-01"),
    ]
    assert [entry.label for entry in allocation(views)] == ["Held"]


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


def test_biggest_changes_skips_a_closed_position() -> None:
    """A sold position never moves again, so it must not stay in the list."""
    views: list[PositionView] = [
        _view(1, name="Sold", delta=400.0, closed_at="2026-03-01"),
        _view(2, name="Mover", delta=7.5),
    ]
    gainers, losers = biggest_changes(views)

    assert [change.name for change in gainers] == ["Mover"]
    assert losers == []


@pytest.mark.parametrize(
    ("points", "grid", "base", "expected"),
    [
        # The first known point maps exactly onto the base.
        ([("2026-01-04", 100.0)], ["2026-01-04"], 1000.0, [1000.0]),
        # A 10 % rise in the index is a 10 % rise on the rebased line.
        (
            [("2026-01-04", 100.0), ("2026-01-11", 110.0)],
            ["2026-01-04", "2026-01-11"],
            1000.0,
            [1000.0, 1100.0],
        ),
        # Grid dates before the first point contribute nothing yet.
        (
            [("2026-01-11", 100.0)],
            ["2026-01-04", "2026-01-11"],
            500.0,
            [0.0, 500.0],
        ),
        # A grid date the feed has no close for keeps the previous one.
        (
            [("2026-01-04", 100.0), ("2026-01-18", 120.0)],
            ["2026-01-04", "2026-01-11", "2026-01-18"],
            1000.0,
            [1000.0, 1000.0, 1200.0],
        ),
        # Nothing to draw: no points, no grid, or an unusable base.
        ([], ["2026-01-04"], 1000.0, []),
        ([("2026-01-04", 100.0)], [], 1000.0, []),
        ([("2026-01-04", 0.0)], ["2026-01-04"], 1000.0, []),
    ],
)
def test_rebase_to_grid(
    points: list[tuple[str, float]],
    grid: list[str],
    base: float,
    expected: list[float],
) -> None:
    """Dated values are carried onto the grid and indexed to the base value."""
    assert rebase_to_grid(points, grid, base) == pytest.approx(expected)


def test_rebase_to_grid_uses_a_close_between_two_grid_dates() -> None:
    """A feed publishing on trading days still lands on a weekly grid."""
    points: list[tuple[str, float]] = [("2026-01-06", 100.0), ("2026-01-09", 105.0)]

    values: list[float] = rebase_to_grid(points, ["2026-01-04", "2026-01-11"], 200.0)

    assert values == pytest.approx([0.0, 210.0])


def test_growth_points_start_at_one() -> None:
    """The index is relative, so the first snapshot is always 1.0."""
    points = growth_points([_snapshot("2026-01-04", 1000.0)])

    assert points == [("2026-01-04", 1.0)]


def test_growth_points_ignore_a_deposit() -> None:
    """Money paid in is not performance — the rule of this whole feature."""
    snapshots = [
        _snapshot("2026-01-04", 1000.0),
        _snapshot("2026-01-11", 2000.0, deposit=1000.0),
    ]

    dates, index = zip(*growth_points(snapshots))

    assert list(dates) == ["2026-01-04", "2026-01-11"]
    # 2000 - 1000 paid in = 1000, unchanged against the opening 1000.
    assert list(index) == pytest.approx([1.0, 1.0])


def test_growth_points_compound_weekly_returns() -> None:
    """Two 10 % weeks make 21 %, not 20 %."""
    snapshots = [
        _snapshot("2026-01-04", 100.0),
        _snapshot("2026-01-11", 110.0),
        _snapshot("2026-01-18", 121.0),
    ]

    _, index = zip(*growth_points(snapshots))

    assert list(index) == pytest.approx([1.0, 1.1, 1.21])


def test_growth_points_survive_a_worthless_week() -> None:
    """A week following a zero value contributes no return instead of dividing by it."""
    snapshots = [
        _snapshot("2026-01-04", 0.0),
        _snapshot("2026-01-11", 500.0, deposit=500.0),
    ]

    _, index = zip(*growth_points(snapshots))

    assert list(index) == pytest.approx([1.0, 1.0])


def test_growth_points_convert_to_eur_first() -> None:
    """A position whose FX rate moved is measured in EUR, not in its own currency."""
    snapshots = [
        _snapshot("2026-01-04", 1080.0, fx_rate=1.08),
        _snapshot("2026-01-11", 1080.0, fx_rate=1.00),
    ]

    _, index = zip(*growth_points(snapshots))

    # 1000 EUR -> 1080 EUR purely from the rate: an 8 % gain for a EUR investor.
    assert list(index) == pytest.approx([1.0, 1.08])
