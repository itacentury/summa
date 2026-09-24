"""Pure derivations for the portfolio area: no Flask, no SQL, no I/O.

Snapshots store only raw facts; every displayed number is derived here on read.
A sale is recorded, not flagged: a sold position's history ends in a derived row
worth 0 with a deposit of minus the proceeds (:func:`with_sale_recorded`), so no
function needs a special case for it.
"""

import calendar
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Final, Literal

RangeToken = Literal["3m", "1y", "ytd", "max"]

RANGE_TOKENS: Final[tuple[str, ...]] = ("3m", "1y", "ytd", "max")
DEFAULT_RANGE: Final[str] = "1y"
ALLOCATION_TOP_N: Final[int] = 5
BIGGEST_CHANGES_COUNT: Final[int] = 3

DEFAULT_CURRENCY: Final[str] = "EUR"
CURRENCY_CODE_LENGTH: Final[int] = 3
DEFAULT_FX_RATE: Final[float] = 1.0
# The precision writers and the JSON boundary round to; this module never rounds.
AMOUNT_DIGITS: Final[int] = 2
CLOSE_DIGITS: Final[int] = 4


@dataclass(frozen=True)
class Snapshot:
    """One weekly reading of a position, in the position's own currency.

    :param fx_rate: units of the position's currency per EUR at that date.
    :param carried: the value was copied forward, not entered by the user.
    :param derived: a sold position's closing row, computed on read, never stored.
    """

    date: str
    value: float
    deposit: float = 0.0
    fx_rate: float = DEFAULT_FX_RATE
    carried: bool = False
    derived: bool = False


@dataclass(frozen=True)
class Position:
    """A held position together with its full snapshot history.

    :param snapshots: ascending by date (every function here relies on that), not
        necessarily distinct: the derived closing row may share a recorded date.
    :param closed_at: sale date; `snapshots` then ends in the row
        :func:`with_sale_recorded` derives.
    """

    id: int
    depot_id: int
    name: str
    kind: str
    currency: str
    snapshots: Sequence[Snapshot]
    is_benchmark_fallback: bool = False
    closed_at: str | None = None
    sort_order: int = 0


@dataclass(frozen=True)
class Depot:
    """A depot the positions are grouped under."""

    id: int
    name: str
    sort_order: int = 0


@dataclass(frozen=True)
class PositionView:
    """Every displayed number for one position.

    :param value: the latest snapshot value, still in the native currency.
    :param snapshot_count: recorded weeks only; the derived closing row is not counted.
    """

    id: int
    depot_id: int
    name: str
    kind: str
    currency: str
    is_benchmark_fallback: bool
    closed_at: str | None
    value: float
    fx_rate: float
    value_eur: float
    invested_eur: float
    contributed_eur: float
    gain: float
    gain_pct: float | None
    week_delta: float | None
    first_snapshot_date: str | None
    last_snapshot_date: str | None
    snapshot_count: int
    sort_order: int


@dataclass(frozen=True)
class DepotView:
    """One depot group with its positions and subtotal."""

    id: int
    name: str
    positions: list[PositionView]
    value_eur: float
    invested_eur: float
    contributed_eur: float
    gain: float
    gain_pct: float | None


@dataclass(frozen=True)
class PortfolioTotals:
    """The grand total behind the three summary cards."""

    value_eur: float
    invested_eur: float
    contributed_eur: float
    gain: float
    gain_pct: float | None
    week_delta: float
    position_count: int
    depot_count: int
    last_snapshot_date: str | None


@dataclass(frozen=True)
class PositionSeries:
    """One position's own value line over the shared chart grid."""

    position_id: int
    name: str
    values: list[float]


@dataclass(frozen=True)
class ChartSeries:
    """The value-over-time lines, one entry per date in a shared grid.

    :param positions: one per input position, same order; one without readings in
        the window is flat at zero.
    """

    dates: list[str]
    portfolio: list[float]
    invested: list[float]
    positions: list[PositionSeries]


@dataclass(frozen=True)
class AllocationSlice:
    """One donut slice.

    :param aggregated_count: 0 for a single position, otherwise the number of
        smaller positions pooled into this slice.
    """

    label: str
    value_eur: float
    share_pct: float
    aggregated_count: int


@dataclass(frozen=True)
class Change:
    """One position's movement over the last week."""

    position_id: int
    name: str
    week_delta: float


@dataclass(frozen=True)
class HistoryRow:
    """One week of a position's history: raw facts plus their EUR readings.

    :param change: the week's deposit-free move in EUR, None where undefined.
    """

    date: str
    value: float
    deposit: float
    fx_rate: float
    carried: bool
    derived: bool
    value_eur: float
    deposit_eur: float
    change: float | None


def with_sale_recorded(
    snapshots: Sequence[Snapshot], closed_at: str | None
) -> Sequence[Snapshot]:
    """Return the history a sold position ends with: worth 0, proceeds withdrawn.

    Derived rather than stored so reopening is lossless. The proceeds leave as a
    negative deposit, keeping the realized gain in ``value - invested``. The row
    follows (not replaces) a week recorded on the close date, so that week's
    deposit still counts in :func:`contributed_eur`; dates are therefore
    ascending, not distinct.

    :param snapshots: ascending by date.
    """
    if closed_at is None:
        return snapshots

    held: list[Snapshot] = [
        snapshot for snapshot in snapshots if snapshot.date <= closed_at
    ]
    if not held:
        return held

    last: Snapshot = held[-1]
    held.append(
        Snapshot(
            date=closed_at,
            value=0.0,
            deposit=-last.value,
            fx_rate=last.fx_rate,
            carried=False,
            derived=True,
        )
    )
    return held


def recorded_weeks(snapshots: Sequence[Snapshot]) -> list[Snapshot]:
    """Return only the weeks the user entered, dropping the derived closing row."""
    return [snapshot for snapshot in snapshots if not snapshot.derived]


def is_currency_code(code: str) -> bool:
    """Return whether ``code`` is three ASCII letters; callers upper-case it first."""
    return len(code) == CURRENCY_CODE_LENGTH and code.isascii() and code.isalpha()


def value_eur(value: float, fx_rate: float) -> float:
    """Convert a native-currency amount to EUR.

    :param fx_rate: units of the currency per EUR; ``CHECK (fx_rate > 0)`` keeps
        this division total.
    """
    return value / fx_rate


def invested_eur(snapshots: Sequence[Snapshot]) -> float:
    """Sum every signed deposit at its own FX rate: the net money still at work.

    A position sold at a profit therefore ends below zero.
    """
    return sum(value_eur(snapshot.deposit, snapshot.fx_rate) for snapshot in snapshots)


def contributed_eur(snapshots: Sequence[Snapshot]) -> float:
    """Sum only the money paid *in*, ignoring withdrawals.

    The :func:`gain_pct` basis: the net invested amount would report -100 % for
    every profitably sold position.
    """
    return sum(
        value_eur(snapshot.deposit, snapshot.fx_rate)
        for snapshot in snapshots
        if snapshot.deposit > 0
    )


def gain(value: float, invested: float) -> float:
    """Return the absolute gain (or loss) of a value against the money put in."""
    return value - invested


def gain_pct(absolute_gain: float, contributed: float) -> float | None:
    """Return the gain as a percentage of what was paid in.

    None when nothing was contributed: undefined, and 0.0 would read as flat.
    """
    if contributed == 0:
        return None
    return absolute_gain / contributed * 100


def week_delta(snapshots: Sequence[Snapshot]) -> float | None:
    """Return the latest recorded week's change in EUR, with its deposit removed.

    Money paid in is not a gain (unlike the old spreadsheet's Delta column). The
    derived closing row is skipped, else every sale would net to exactly zero.
    None with fewer than two recorded weeks: a first deposit is no move.

    :param snapshots: ascending by date.
    """
    weeks: list[Snapshot] = recorded_weeks(snapshots)
    if len(weeks) < 2:
        return None
    latest: Snapshot = weeks[-1]
    previous: Snapshot = weeks[-2]
    return (
        value_eur(latest.value, latest.fx_rate)
        - value_eur(previous.value, previous.fx_rate)
        - value_eur(latest.deposit, latest.fx_rate)
    )


def history_rows(snapshots: Sequence[Snapshot]) -> list[HistoryRow]:
    """Return a position's full history, one row per snapshot, ascending by date.

    ``change`` applies the :func:`week_delta` rule to every week. It is None on
    the first row and on the derived closing row, a withdrawal rather than a
    market move (else every sale would read as a wipeout).

    :param snapshots: ascending by date.
    """
    rows: list[HistoryRow] = []
    previous: Snapshot | None = None
    for snapshot in snapshots:
        converted: float = value_eur(snapshot.value, snapshot.fx_rate)
        paid_in: float = value_eur(snapshot.deposit, snapshot.fx_rate)
        change: float | None = None
        if not snapshot.derived and previous is not None:
            change = converted - value_eur(previous.value, previous.fx_rate) - paid_in
        rows.append(
            HistoryRow(
                date=snapshot.date,
                value=snapshot.value,
                deposit=snapshot.deposit,
                fx_rate=snapshot.fx_rate,
                carried=snapshot.carried,
                derived=snapshot.derived,
                value_eur=converted,
                deposit_eur=paid_in,
                change=change,
            )
        )
        if not snapshot.derived:
            previous = snapshot
    return rows


def growth_points(snapshots: Sequence[Snapshot]) -> list[tuple[str, float]]:
    """Return a position's deposit-free growth index, one point per snapshot.

    Starts at 1.0 and compounds ``(value - deposit) / previous_value``, so a
    deposit never reads as index performance. A week after a worthless one adds
    no return.

    :param snapshots: ascending by date.
    """
    points: list[tuple[str, float]] = []
    index: float = 1.0
    previous: Snapshot | None = None
    for snapshot in snapshots:
        if previous is not None:
            opening: float = value_eur(previous.value, previous.fx_rate)
            if opening != 0:
                closing: float = value_eur(snapshot.value, snapshot.fx_rate)
                paid_in: float = value_eur(snapshot.deposit, snapshot.fx_rate)
                index *= (closing - paid_in) / opening
        points.append((snapshot.date, index))
        previous = snapshot
    return points


def _shift_months(anchor: date, months: int) -> date:
    """Return `anchor` moved back by `months`, clamped to the target month's length."""
    total_months: int = (anchor.year * 12 + anchor.month - 1) - months
    year: int = total_months // 12
    month: int = total_months % 12 + 1
    day: int = min(anchor.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def range_start(range_token: str, today: date) -> date | None:
    """Return the inclusive window start for a period token.

    None means unbounded ("max"), also for an unknown token: validation is the
    API layer's job.
    """
    if range_token == "3m":
        return _shift_months(today, 3)
    if range_token == "1y":
        return _shift_months(today, 12)
    if range_token == "ytd":
        return date(today.year, 1, 1)
    return None


@dataclass(frozen=True)
class ChartWindow:
    """The x-axis span of the chart, independent of which dates carry data."""

    start: str | None
    end: str


def chart_window(range_token: str, today: date, dates: Sequence[str]) -> ChartWindow:
    """Return the axis boundaries for a period token as ISO dates.

    The grid holds only dates with data, so the axis width comes from here. The
    start falls back to the first date for "max"; the end is today unless an
    imported snapshot dates later (the API rejects future dates, the importer
    does not).

    :param dates: the chart's date grid, ascending.
    """
    start: date | None = range_start(range_token, today)
    if start is not None:
        start_iso: str | None = start.isoformat()
    else:
        start_iso = dates[0] if dates else None
    today_iso: str = today.isoformat()
    end_iso: str = max(today_iso, dates[-1]) if dates else today_iso
    return ChartWindow(start=start_iso, end=end_iso)


def snapshot_dates(positions: Sequence[Position], start: date | None) -> list[str]:
    """Return every distinct snapshot date at or after `start`, ascending."""
    boundary: str | None = start.isoformat() if start is not None else None
    dates: set[str] = set()
    for position in positions:
        for snapshot in position.snapshots:
            if boundary is None or snapshot.date >= boundary:
                dates.add(snapshot.date)
    return sorted(dates)


def _position_series(
    position: Position, grid: Sequence[str]
) -> tuple[list[float], list[float]]:
    """Return one position's value and cumulative deposits for each date in `grid`.

    The value is carried forward over missing weeks; dates before the first
    snapshot yield 0.0.
    """
    values: list[float] = []
    deposits: list[float] = []
    index: int = 0
    current_value: float = 0.0
    deposited: float = 0.0
    for grid_date in grid:
        while (
            index < len(position.snapshots)
            and position.snapshots[index].date <= grid_date
        ):
            snapshot: Snapshot = position.snapshots[index]
            current_value = value_eur(snapshot.value, snapshot.fx_rate)
            deposited += value_eur(snapshot.deposit, snapshot.fx_rate)
            index += 1
        values.append(current_value)
        deposits.append(deposited)
    return values, deposits


def build_series(positions: Sequence[Position], dates: Sequence[str]) -> ChartSeries:
    """Sum all positions into the portfolio and invested lines, keeping each one's own line."""
    grid: list[str] = list(dates)
    portfolio: list[float] = [0.0] * len(grid)
    invested: list[float] = [0.0] * len(grid)
    per_position: list[PositionSeries] = []
    for position in positions:
        values, deposits = _position_series(position, grid)
        for slot in range(len(grid)):
            portfolio[slot] += values[slot]
            invested[slot] += deposits[slot]
        per_position.append(
            PositionSeries(
                position_id=position.id,
                name=position.name,
                values=values,
            )
        )
    return ChartSeries(
        dates=grid,
        portfolio=portfolio,
        invested=invested,
        positions=per_position,
    )


def _anchor_value(points: Sequence[tuple[str, float]], grid_start: str) -> float:
    """Return the value a dated series holds at the grid's first date.

    Anchoring on the earliest point instead would scale a longer feed by what the
    index did before the portfolio existed.

    :param points: (date, value) pairs, ascending by date.
    """
    anchor: float = points[0][1]
    for point_date, value in points:
        if point_date > grid_start:
            break
        anchor = value
    return anchor


def rebase_to_grid(
    points: Sequence[tuple[str, float]], grid: Sequence[str], base: float
) -> list[float]:
    """Align dated values onto a date grid and scale them to start at `base`.

    Points are carried forward like position values (trading-day feed vs. weekly
    grid). Scaling turns an index close into "what the same money would have
    done in the index".

    :param points: (date, value) pairs, ascending by date.
    :param grid: the chart's dates, ascending.
    """
    if not points or not grid or base == 0:
        return []

    anchor: float = _anchor_value(points, grid[0])
    if anchor == 0:
        return []

    factor: float = base / anchor
    values: list[float] = []
    index: int = 0
    current: float = 0.0
    for grid_date in grid:
        while index < len(points) and points[index][0] <= grid_date:
            current = points[index][1] * factor
            index += 1
        values.append(current)
    return values


def build_position_view(position: Position) -> PositionView:
    """Derive every displayed number for one position from its snapshots."""
    latest: Snapshot | None = position.snapshots[-1] if position.snapshots else None
    native_value: float = latest.value if latest is not None else 0.0
    fx_rate: float = latest.fx_rate if latest is not None else DEFAULT_FX_RATE
    current_value: float = value_eur(native_value, fx_rate)
    invested: float = invested_eur(position.snapshots)
    contributed: float = contributed_eur(position.snapshots)
    absolute_gain: float = gain(current_value, invested)
    return PositionView(
        id=position.id,
        depot_id=position.depot_id,
        name=position.name,
        kind=position.kind,
        currency=position.currency,
        is_benchmark_fallback=position.is_benchmark_fallback,
        closed_at=position.closed_at,
        value=native_value,
        fx_rate=fx_rate,
        value_eur=current_value,
        invested_eur=invested,
        contributed_eur=contributed,
        gain=absolute_gain,
        gain_pct=gain_pct(absolute_gain, contributed),
        week_delta=week_delta(position.snapshots),
        first_snapshot_date=position.snapshots[0].date if position.snapshots else None,
        last_snapshot_date=latest.date if latest is not None else None,
        snapshot_count=len(recorded_weeks(position.snapshots)),
        sort_order=position.sort_order,
    )


def _by_sort_order(view: PositionView) -> tuple[int, str]:
    """Sort key for positions: explicit order first, then name."""
    return view.sort_order, view.name


def by_depot_order(depot: Depot) -> tuple[int, str]:
    """Sort key for depots: explicit order first, then name."""
    return depot.sort_order, depot.name


def build_depot_views(
    depots: Sequence[Depot], position_views: Sequence[PositionView]
) -> list[DepotView]:
    """Group positions under their depots and add a subtotal to each group.

    Empty depots are kept: a new depot is legitimately empty.
    """
    grouped: dict[int, list[PositionView]] = {depot.id: [] for depot in depots}
    for view in position_views:
        if view.depot_id in grouped:
            grouped[view.depot_id].append(view)

    views: list[DepotView] = []
    for depot in sorted(depots, key=by_depot_order):
        members: list[PositionView] = sorted(grouped[depot.id], key=_by_sort_order)
        depot_value: float = sum(member.value_eur for member in members)
        depot_invested: float = sum(member.invested_eur for member in members)
        depot_contributed: float = sum(member.contributed_eur for member in members)
        depot_gain: float = gain(depot_value, depot_invested)
        views.append(
            DepotView(
                id=depot.id,
                name=depot.name,
                positions=members,
                value_eur=depot_value,
                invested_eur=depot_invested,
                contributed_eur=depot_contributed,
                gain=depot_gain,
                gain_pct=gain_pct(depot_gain, depot_contributed),
            )
        )
    return views


def build_totals(
    position_views: Sequence[PositionView], depot_count: int
) -> PortfolioTotals:
    """Sum every position into the grand total behind the summary cards.

    Sold positions count too: their negative deposit keeps the realized gain.
    """
    total_value: float = sum(view.value_eur for view in position_views)
    total_invested: float = sum(view.invested_eur for view in position_views)
    total_contributed: float = sum(view.contributed_eur for view in position_views)
    total_gain: float = gain(total_value, total_invested)
    # Closed positions are skipped: their last delta would never be replaced and
    # would report into "this week" for good.
    total_delta: float = sum(
        view.week_delta
        for view in position_views
        if view.week_delta is not None and view.closed_at is None
    )
    seen_dates: list[str] = [
        view.last_snapshot_date
        for view in position_views
        if view.last_snapshot_date is not None
    ]
    return PortfolioTotals(
        value_eur=total_value,
        invested_eur=total_invested,
        contributed_eur=total_contributed,
        gain=total_gain,
        gain_pct=gain_pct(total_gain, total_contributed),
        week_delta=total_delta,
        # Counts what is still held.
        position_count=sum(1 for view in position_views if view.closed_at is None),
        depot_count=depot_count,
        last_snapshot_date=max(seen_dates) if seen_dates else None,
    )


def _by_value_eur(view: PositionView) -> float:
    """Sort key: a position's EUR value."""
    return view.value_eur


def allocation(
    position_views: Sequence[PositionView], top_n: int = ALLOCATION_TOP_N
) -> list[AllocationSlice]:
    """Return the donut slices: the largest positions, then the rest pooled into one.

    The `closed_at` filter guards a row closed without its zeroing snapshot;
    worthless positions are dropped to avoid invisible 0 % slices.
    """
    held: list[PositionView] = [
        view for view in position_views if view.closed_at is None and view.value_eur > 0
    ]
    total: float = sum(view.value_eur for view in held)
    if total == 0:
        return []

    ranked: list[PositionView] = sorted(held, key=_by_value_eur, reverse=True)
    slices: list[AllocationSlice] = [
        AllocationSlice(
            label=view.name,
            value_eur=view.value_eur,
            share_pct=view.value_eur / total * 100,
            aggregated_count=0,
        )
        for view in ranked[:top_n]
    ]

    remainder: list[PositionView] = ranked[top_n:]
    if remainder:
        pooled: float = sum(view.value_eur for view in remainder)
        slices.append(
            AllocationSlice(
                label=f"{len(remainder)} more",
                value_eur=pooled,
                share_pct=pooled / total * 100,
                aggregated_count=len(remainder),
            )
        )
    return slices


def _by_week_delta(change: Change) -> float:
    """Sort key: a change's weekly delta."""
    return change.week_delta


def biggest_changes(
    position_views: Sequence[PositionView], count: int = BIGGEST_CHANGES_COUNT
) -> tuple[list[Change], list[Change]]:
    """Return the week's largest gainers and losers, biggest movement first.

    Positions without a previous week, flat ones and sold ones are left out; a
    sold one's last move would otherwise stay in the list forever.
    """
    movers: list[Change] = []
    for view in position_views:
        delta: float | None = view.week_delta
        if delta is None or delta == 0 or view.closed_at is not None:
            continue
        movers.append(Change(position_id=view.id, name=view.name, week_delta=delta))

    gainers: list[Change] = sorted(
        (change for change in movers if change.week_delta > 0),
        key=_by_week_delta,
        reverse=True,
    )
    losers: list[Change] = sorted(
        (change for change in movers if change.week_delta < 0), key=_by_week_delta
    )
    return gainers[:count], losers[:count]
