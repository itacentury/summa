"""Pure derivations for the portfolio area: no Flask, no SQL, no I/O.

The schema stores only raw facts — a snapshot holds a value, a deposit and an FX
rate in the position's own currency. Everything the Portfolio screen displays is
computed from those rows on every read: EUR conversions, invested sums, gains,
the weekly delta, the chart series, allocation shares and the biggest movers.

Keeping this layer free of Flask and SQLite is what makes those rules testable on
their own, before any HTTP or query shape exists to hide a mistake in.
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


@dataclass(frozen=True)
class Snapshot:
    """One weekly reading of a position, in the position's own currency.

    :param fx_rate: units of the position's currency per EUR at that date.
    :param carried: the value was copied forward, not entered by the user.
    """

    date: str
    value: float
    deposit: float = 0.0
    fx_rate: float = 1.0
    carried: bool = False


@dataclass(frozen=True)
class Position:
    """A held position together with its full snapshot history.

    :param snapshots: ascending by date — every function here relies on that.
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
    :param gain_pct: None when nothing is invested — see :func:`gain_pct`.
    :param week_delta: None when there is no previous week — see :func:`week_delta`.
    """

    id: int
    depot_id: int
    name: str
    kind: str
    currency: str
    is_benchmark_fallback: bool
    is_closed: bool
    value: float
    fx_rate: float
    value_eur: float
    invested_eur: float
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
    gain: float
    gain_pct: float | None


@dataclass(frozen=True)
class PortfolioTotals:
    """The grand total behind the three summary cards."""

    value_eur: float
    invested_eur: float
    gain: float
    gain_pct: float | None
    week_delta: float
    position_count: int
    depot_count: int
    last_snapshot_date: str | None


@dataclass(frozen=True)
class ChartSeries:
    """The value-over-time lines, one entry per date in a shared grid."""

    dates: list[str]
    portfolio: list[float]
    invested: list[float]


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


def value_eur(value: float, fx_rate: float) -> float:
    """Convert a native-currency amount to EUR.

    :param fx_rate: units of the position's currency per EUR; the schema's
        ``CHECK (fx_rate > 0)`` is what makes this division total.
    """
    return value / fx_rate


def invested_eur(snapshots: Sequence[Snapshot]) -> float:
    """Sum every deposit of a position's history, each at its own FX rate."""
    return sum(value_eur(snapshot.deposit, snapshot.fx_rate) for snapshot in snapshots)


def gain(value: float, invested: float) -> float:
    """Return the absolute gain (or loss) of a value against the money put in."""
    return value - invested


def gain_pct(absolute_gain: float, invested: float) -> float | None:
    """Return the gain as a percentage of the invested amount.

    None when nothing is invested: the percentage is undefined there, and a 0.0
    would be indistinguishable from a genuinely flat position.
    """
    if invested == 0:
        return None
    return absolute_gain / invested * 100


def week_delta(snapshots: Sequence[Snapshot]) -> float | None:
    """Return the latest week's change in EUR, with that week's deposit removed.

    ``latest.value_eur - previous.value_eur - latest.deposit_eur``. Subtracting
    the deposit is the deliberate difference from the Delta column of the
    spreadsheet this feature replaces: money paid in is not a gain.

    None when the position has fewer than two snapshots — without a previous
    week any number would be invented, and a fresh position's first deposit
    would surface as the week's biggest winner.

    :param snapshots: ascending by date.
    """
    if len(snapshots) < 2:
        return None
    latest: Snapshot = snapshots[-1]
    previous: Snapshot = snapshots[-2]
    return (
        value_eur(latest.value, latest.fx_rate)
        - value_eur(previous.value, previous.fx_rate)
        - value_eur(latest.deposit, latest.fx_rate)
    )


def growth_points(snapshots: Sequence[Snapshot]) -> list[tuple[str, float]]:
    """Return a position's deposit-free growth index, one point per snapshot.

    The index starts at 1.0 and compounds each week's return with that week's
    deposit removed: ``(value - deposit) / previous_value``. Feeding raw values
    to a benchmark line instead would make the line jump every time money was
    paid into the position, reading as index performance nobody earned — the
    same mistake the Excel Delta column makes, one chart line over.

    A week following a worthless one contributes no return: there is nothing for
    the new value to be a multiple of.

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

    None means unbounded ("max"), which is also the fallback for an unrecognized
    token: showing everything is the harmless outcome, and rejecting bad input is
    the API layer's job.
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

    The date grid holds only dates that exist, so three months of history under
    "1y" would draw a three-month axis. The window says how wide the axis should
    be instead, keeping the period arithmetic (and its month clamping) on this
    side rather than duplicated in the chart client.

    The start is the window start, or — for the unbounded "max", where there is
    none to compute — the first date with data; None only when neither exists.
    The end is today, unless a snapshot dates after it: the API rejects future
    dates but the import script does not, and clipping a real point is worse than
    an axis running slightly long.

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
    """Return every distinct snapshot date at or after `start`, ascending.

    The dates are ISO strings, so comparing and sorting them as text is the same
    as comparing them as dates — no parsing needed.
    """
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

    The value is carried forward: a date the position has no row for keeps the
    most recent earlier one, so a missing week does not drop the position out of
    the portfolio line. Dates before the position's first snapshot yield 0.0 — it
    does not exist yet and contributes nothing, rather than starting at zero on
    its own line.
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
    """Sum every position into the portfolio and invested lines over one date grid."""
    grid: list[str] = list(dates)
    portfolio: list[float] = [0.0] * len(grid)
    invested: list[float] = [0.0] * len(grid)
    for position in positions:
        values, deposits = _position_series(position, grid)
        for slot in range(len(grid)):
            portfolio[slot] += values[slot]
            invested[slot] += deposits[slot]
    return ChartSeries(dates=grid, portfolio=portfolio, invested=invested)


def rebase_to_grid(
    points: Sequence[tuple[str, float]], grid: Sequence[str], base: float
) -> list[float]:
    """Align dated values onto a date grid and scale them to start at `base`.

    Points are carried forward exactly as position values are: a grid date
    without a point of its own keeps the most recent earlier one, and dates
    before the first point yield 0.0. A benchmark feed publishes on trading days
    while the portfolio grid is weekly, so the two rarely line up.

    The scaling is what makes the line comparable at all. An index close is a
    number like 142.18 while the portfolio is in euros, so the raw series would
    draw a flat line along the bottom of the chart. Indexed to `base` it answers
    the question the chart actually asks: what the same starting money would have
    done in the index.

    :param points: (date, value) pairs, ascending by date.
    :param grid: the chart's dates, ascending.
    :param base: the value the first known point is scaled to.
    """
    if not points or not grid or base == 0 or points[0][1] == 0:
        return []

    factor: float = base / points[0][1]
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
    fx_rate: float = latest.fx_rate if latest is not None else 1.0
    current_value: float = value_eur(native_value, fx_rate)
    invested: float = invested_eur(position.snapshots)
    absolute_gain: float = gain(current_value, invested)
    return PositionView(
        id=position.id,
        depot_id=position.depot_id,
        name=position.name,
        kind=position.kind,
        currency=position.currency,
        is_benchmark_fallback=position.is_benchmark_fallback,
        is_closed=position.closed_at is not None,
        value=native_value,
        fx_rate=fx_rate,
        value_eur=current_value,
        invested_eur=invested,
        gain=absolute_gain,
        gain_pct=gain_pct(absolute_gain, invested),
        week_delta=week_delta(position.snapshots),
        first_snapshot_date=position.snapshots[0].date if position.snapshots else None,
        last_snapshot_date=latest.date if latest is not None else None,
        snapshot_count=len(position.snapshots),
        sort_order=position.sort_order,
    )


def _by_sort_order(view: PositionView) -> tuple[int, str]:
    """Sort key for positions: explicit order first, then name."""
    return view.sort_order, view.name


def _by_depot_order(depot: Depot) -> tuple[int, str]:
    """Sort key for depots: explicit order first, then name."""
    return depot.sort_order, depot.name


def build_depot_views(
    depots: Sequence[Depot], position_views: Sequence[PositionView]
) -> list[DepotView]:
    """Group positions under their depots and add a subtotal to each group.

    Depots without positions are kept: an empty depot is a legitimate state right
    after one is created, and the settings screen lists it.
    """
    grouped: dict[int, list[PositionView]] = {depot.id: [] for depot in depots}
    for view in position_views:
        # A position whose depot was not passed in (filtered out) simply drops.
        if view.depot_id in grouped:
            grouped[view.depot_id].append(view)

    views: list[DepotView] = []
    for depot in sorted(depots, key=_by_depot_order):
        members: list[PositionView] = sorted(grouped[depot.id], key=_by_sort_order)
        depot_value: float = sum(member.value_eur for member in members)
        depot_invested: float = sum(member.invested_eur for member in members)
        depot_gain: float = gain(depot_value, depot_invested)
        views.append(
            DepotView(
                id=depot.id,
                name=depot.name,
                positions=members,
                value_eur=depot_value,
                invested_eur=depot_invested,
                gain=depot_gain,
                gain_pct=gain_pct(depot_gain, depot_invested),
            )
        )
    return views


def build_totals(
    position_views: Sequence[PositionView], depot_count: int
) -> PortfolioTotals:
    """Sum every position into the grand total behind the summary cards."""
    total_value: float = sum(view.value_eur for view in position_views)
    total_invested: float = sum(view.invested_eur for view in position_views)
    total_gain: float = gain(total_value, total_invested)
    # A position without a previous week contributes nothing here; falling back
    # to its full value would read as a one-week gain of the whole position.
    total_delta: float = sum(
        view.week_delta for view in position_views if view.week_delta is not None
    )
    # ISO dates sort as text, so max() picks the most recent snapshot date.
    seen_dates: list[str] = [
        view.last_snapshot_date
        for view in position_views
        if view.last_snapshot_date is not None
    ]
    return PortfolioTotals(
        value_eur=total_value,
        invested_eur=total_invested,
        gain=total_gain,
        gain_pct=gain_pct(total_gain, total_invested),
        week_delta=total_delta,
        # The "n positions · m depots" sub-line counts what is still held.
        position_count=sum(1 for view in position_views if not view.is_closed),
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

    Closed positions are left out — `closed_at` means sold, so that money is not
    allocated anywhere any more. Worthless positions are dropped too: they would
    draw an invisible slice and a 0 % legend row.
    """
    held: list[PositionView] = [
        view for view in position_views if not view.is_closed and view.value_eur > 0
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

    Fewer than `count` entries per side is normal: a position with no previous
    week and a flat one are both not movers and are left out.
    """
    movers: list[Change] = []
    for view in position_views:
        delta: float | None = view.week_delta
        if delta is None or delta == 0:
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
