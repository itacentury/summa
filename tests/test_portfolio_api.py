"""Tests for the portfolio REST API in :mod:`summa.routes.portfolio`.

The numeric rules are already proven by :mod:`tests.test_portfolio` against the
pure layer, so these tests target what this layer can actually get wrong: which
rows a query loads, what a filter narrows, and what survives the trip into JSON.
"""

from datetime import date, timedelta
from typing import Any

import pytest
from flask.testing import FlaskClient

from summa import db
from tests.conftest import SeedDepot, SeedPosition, SeedSnapshot


def _weeks_ago(weeks: int) -> str:
    """Return the ISO date `weeks` weeks before today."""
    return (date.today() - timedelta(weeks=weeks)).isoformat()


def _snapshot_rows(position_id: int) -> list[dict[str, Any]]:
    """Read a position's snapshots straight from the database, ascending."""
    conn = db.get_db()
    try:
        cursor = conn.execute(
            "SELECT date, value, deposit, fx_rate, carried FROM portfolio_snapshots "
            "WHERE position_id = ? ORDER BY date",
            (position_id,),
        )
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def _seed_benchmark_price(symbol: str, price_date: str, close: float) -> None:
    """Insert one feed close straight into the database."""
    conn = db.get_db()
    try:
        conn.execute(
            "INSERT INTO benchmark_prices (symbol, date, close) VALUES (?, ?, ?)",
            (symbol, price_date, close),
        )
        conn.commit()
    finally:
        conn.close()


def _position_names(payload: dict[str, Any]) -> list[str]:
    """Return every position name in the response, across all depot groups."""
    names: list[str] = []
    for depot in payload["depots"]:
        for position in depot["positions"]:
            names.append(position["name"])
    return names


# --- GET /api/portfolio -----------------------------------------------------


def test_get_portfolio_is_empty_without_any_data(client: FlaskClient) -> None:
    """An untouched installation answers 200 with empty lists, not a 500."""
    response = client.get("/api/portfolio")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["depots"] == []
    assert payload["allocation"] == []
    assert payload["changes"] == {"gainers": [], "losers": []}
    assert payload["series"] == {
        "dates": [],
        "portfolio": [],
        "invested": [],
        "benchmark": [],
    }
    assert payload["benchmark_source"] is None
    assert payload["totals"]["value_eur"] == 0
    assert payload["totals"]["position_count"] == 0


def test_get_portfolio_groups_positions_under_depots_with_subtotals(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """Two positions in one depot roll up into that depot's subtotal."""
    depot_id = seed_depot()
    first = seed_position(depot_id, name="A", sort_order=0)
    second = seed_position(depot_id, name="B", sort_order=1)
    seed_snapshot(first, _weeks_ago(1), 1000.0, deposit=900.0)
    seed_snapshot(second, _weeks_ago(1), 500.0, deposit=500.0)

    payload = client.get("/api/portfolio").get_json()

    assert len(payload["depots"]) == 1
    depot = payload["depots"][0]
    assert [position["name"] for position in depot["positions"]] == ["A", "B"]
    assert depot["value_eur"] == 1500.0
    assert depot["invested_eur"] == 1400.0
    assert depot["gain"] == 100.0
    assert payload["totals"]["value_eur"] == 1500.0
    assert payload["totals"]["depot_count"] == 1
    assert payload["totals"]["position_count"] == 2


def test_get_portfolio_range_narrows_the_chart_but_not_the_list(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """A short period trims the series; the position list keeps current values."""
    depot_id = seed_depot()
    position_id = seed_position(depot_id)
    seed_snapshot(position_id, _weeks_ago(60), 800.0, deposit=800.0)
    seed_snapshot(position_id, _weeks_ago(1), 1000.0, deposit=100.0)

    short = client.get("/api/portfolio?range=3m").get_json()
    full = client.get("/api/portfolio?range=max").get_json()

    assert len(short["series"]["dates"]) == 1
    assert len(full["series"]["dates"]) == 2
    # The list and the totals are identical: only the chart is windowed.
    assert short["totals"] == full["totals"]
    assert short["depots"] == full["depots"]


def test_get_portfolio_falls_back_to_the_default_range_on_a_bad_token(
    client: FlaskClient,
) -> None:
    """An unrecognized range degrades to the default instead of failing."""
    response = client.get("/api/portfolio?range=5y")

    assert response.status_code == 200
    assert response.get_json()["range"] == "1y"


def test_get_portfolio_depot_filter_narrows_everything(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """A depot filter narrows the list, the totals, the allocation and the series."""
    kept = seed_depot(name="Trade Republic")
    other = seed_depot(name="Deka")
    kept_position = seed_position(kept, name="Kept")
    other_position = seed_position(other, name="Other")
    seed_snapshot(kept_position, _weeks_ago(2), 1000.0, deposit=1000.0)
    seed_snapshot(other_position, _weeks_ago(1), 500.0, deposit=500.0)

    payload = client.get(f"/api/portfolio?depot={kept}").get_json()

    assert payload["depot"] == kept
    assert _position_names(payload) == ["Kept"]
    assert payload["totals"]["value_eur"] == 1000.0
    assert payload["totals"]["depot_count"] == 1
    assert [entry["label"] for entry in payload["allocation"]] == ["Kept"]
    # The other depot's snapshot date is gone from the grid entirely.
    assert payload["series"]["dates"] == [_weeks_ago(2)]
    assert payload["series"]["portfolio"] == [1000.0]


def test_get_portfolio_converts_a_foreign_currency_position(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """The FX rate survives the row -> dataclass -> JSON trip."""
    depot_id = seed_depot()
    position_id = seed_position(depot_id, name="FTSE All-World", currency="USD")
    seed_snapshot(position_id, _weeks_ago(1), 1080.0, deposit=1080.0, fx_rate=1.08)

    payload = client.get("/api/portfolio").get_json()
    position = payload["depots"][0]["positions"][0]

    assert position["currency"] == "USD"
    assert position["value"] == 1080.0
    assert position["value_eur"] == 1000.0
    assert position["invested_eur"] == 1000.0
    assert position["fx_rate"] == 1.08


def test_get_portfolio_keeps_undefined_numbers_null(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """A first-ever snapshot has no delta, and nothing invested has no percentage."""
    depot_id = seed_depot()
    position_id = seed_position(depot_id)
    seed_snapshot(position_id, _weeks_ago(1), 1000.0, deposit=0.0)

    position = client.get("/api/portfolio").get_json()["depots"][0]["positions"][0]

    assert position["week_delta"] is None
    assert position["gain_pct"] is None


def test_get_portfolio_week_delta_removes_the_deposit(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """A week that only grew by its deposit shows no gain — the rule of this feature."""
    depot_id = seed_depot()
    position_id = seed_position(depot_id)
    seed_snapshot(position_id, _weeks_ago(2), 1000.0, deposit=1000.0)
    seed_snapshot(position_id, _weeks_ago(1), 2000.0, deposit=1000.0)

    payload = client.get("/api/portfolio").get_json()

    assert payload["depots"][0]["positions"][0]["week_delta"] == 0.0
    assert payload["totals"]["week_delta"] == 0.0


def test_get_portfolio_keeps_a_closed_position_out_of_the_allocation_only(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """closed_at means sold, not deleted: it leaves the donut but stays in the total."""
    depot_id = seed_depot()
    held = seed_position(depot_id, name="Held")
    sold = seed_position(depot_id, name="Sold", closed_at="2026-01-31")
    seed_snapshot(held, _weeks_ago(1), 1500.0, deposit=1500.0)
    seed_snapshot(sold, _weeks_ago(1), 500.0, deposit=500.0)

    payload = client.get("/api/portfolio").get_json()

    assert [entry["label"] for entry in payload["allocation"]] == ["Held"]
    assert payload["totals"]["value_eur"] == 2000.0
    assert payload["totals"]["position_count"] == 1
    assert "Sold" in _position_names(payload)


def test_get_portfolio_splits_biggest_changes_into_gainers_and_losers(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """The movers are sorted by magnitude and split by sign."""
    depot_id = seed_depot()
    winner = seed_position(depot_id, name="Winner")
    loser = seed_position(depot_id, name="Loser")
    seed_snapshot(winner, _weeks_ago(2), 1000.0)
    seed_snapshot(winner, _weeks_ago(1), 1100.0)
    seed_snapshot(loser, _weeks_ago(2), 1000.0)
    seed_snapshot(loser, _weeks_ago(1), 950.0)

    changes = client.get("/api/portfolio").get_json()["changes"]

    assert [entry["name"] for entry in changes["gainers"]] == ["Winner"]
    assert changes["gainers"][0]["week_delta"] == 100.0
    assert [entry["name"] for entry in changes["losers"]] == ["Loser"]
    assert changes["losers"][0]["week_delta"] == -50.0


# --- Benchmark --------------------------------------------------------------


def test_get_portfolio_falls_back_silently_without_a_feed(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """An empty benchmark_prices table yields the flagged position, not an error."""
    depot_id = seed_depot()
    flagged = seed_position(depot_id, name="MSCI", is_benchmark_fallback=True)
    other = seed_position(depot_id, name="Other")
    seed_snapshot(flagged, _weeks_ago(2), 1000.0)
    seed_snapshot(flagged, _weeks_ago(1), 1100.0)
    seed_snapshot(other, _weeks_ago(2), 500.0)
    seed_snapshot(other, _weeks_ago(1), 500.0)

    response = client.get("/api/portfolio")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["benchmark_source"] == "fallback"
    assert payload["benchmark_updated_at"] == _weeks_ago(1)
    # Indexed to the portfolio's opening value, then following its own growth.
    assert payload["series"]["benchmark"] == [1500.0, 1650.0]


def test_get_portfolio_fallback_benchmark_ignores_deposits(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """A deposit into the fallback position must not lift the benchmark line.

    Without this the line would double because the user transferred money, the
    same mistake the spreadsheet's Delta column makes one line over.
    """
    depot_id = seed_depot()
    position_id = seed_position(depot_id, is_benchmark_fallback=True)
    seed_snapshot(position_id, _weeks_ago(2), 1000.0, deposit=1000.0)
    seed_snapshot(position_id, _weeks_ago(1), 2050.0, deposit=1000.0)

    payload = client.get("/api/portfolio").get_json()

    # 5 % of real growth on an opening 1000, not the 105 % the raw values show.
    assert payload["series"]["benchmark"] == [1000.0, 1050.0]


def test_get_portfolio_uses_the_feed_when_prices_exist(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """Feed rows inside the window win over the fallback position."""
    depot_id = seed_depot()
    position_id = seed_position(depot_id, is_benchmark_fallback=True)
    seed_snapshot(position_id, _weeks_ago(2), 1000.0)
    seed_snapshot(position_id, _weeks_ago(1), 1100.0)
    _seed_benchmark_price("URTH", _weeks_ago(2), 100.0)
    _seed_benchmark_price("URTH", _weeks_ago(1), 110.0)

    payload = client.get("/api/portfolio").get_json()

    assert payload["benchmark_source"] == "feed"
    assert payload["benchmark_updated_at"] == _weeks_ago(1)
    # Rebased: 100 -> the portfolio's 1000, so the 10 % rise lands on 1100.
    assert payload["series"]["benchmark"] == [1000.0, 1100.0]


def test_get_portfolio_falls_back_when_the_feed_is_older_than_the_window(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """A stale feed is treated exactly like a missing one."""
    depot_id = seed_depot()
    position_id = seed_position(depot_id, is_benchmark_fallback=True)
    seed_snapshot(position_id, _weeks_ago(2), 1000.0)
    seed_snapshot(position_id, _weeks_ago(1), 1100.0)
    _seed_benchmark_price("URTH", _weeks_ago(200), 100.0)

    payload = client.get("/api/portfolio?range=3m").get_json()

    assert payload["benchmark_source"] == "fallback"


def test_get_portfolio_has_no_benchmark_line_without_a_flagged_position(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """No feed and no fallback simply means two lines instead of three."""
    depot_id = seed_depot()
    position_id = seed_position(depot_id)
    seed_snapshot(position_id, _weeks_ago(1), 1000.0)

    payload = client.get("/api/portfolio").get_json()

    assert payload["series"]["benchmark"] == []
    assert payload["benchmark_source"] is None


# --- GET /api/portfolio/snapshot/new ----------------------------------------


def test_snapshot_prefill_carries_the_previous_reading(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """Each active position arrives with its last value, rate and date."""
    depot_id = seed_depot()
    position_id = seed_position(depot_id, currency="USD")
    seed_snapshot(position_id, _weeks_ago(1), 1080.0, fx_rate=1.08)

    payload = client.get("/api/portfolio/snapshot/new").get_json()
    position = payload["depots"][0]["positions"][0]

    assert position["previous_value"] == 1080.0
    assert position["previous_fx_rate"] == 1.08
    assert position["previous_date"] == _weeks_ago(1)
    assert payload["last_snapshot_date"] == _weeks_ago(1)
    assert payload["suggested_date"] == _weeks_ago(0)


def test_snapshot_prefill_suggests_today_without_history(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """The very first snapshot has no previous week to step forward from."""
    seed_position(seed_depot())

    payload = client.get("/api/portfolio/snapshot/new").get_json()

    assert payload["last_snapshot_date"] is None
    assert payload["suggested_date"] == date.today().isoformat()
    assert payload["depots"][0]["positions"][0]["previous_value"] is None


def test_snapshot_prefill_omits_closed_positions(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """A sold position has nothing left to record a weekly value for."""
    depot_id = seed_depot()
    seed_position(depot_id, name="Held")
    seed_position(depot_id, name="Sold", closed_at="2026-01-31")

    payload = client.get("/api/portfolio/snapshot/new").get_json()

    assert [p["name"] for p in payload["depots"][0]["positions"]] == ["Held"]


# --- POST /api/portfolio/snapshot -------------------------------------------


def test_post_snapshot_inserts_a_row(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """A plain snapshot lands in the database as entered."""
    position_id = seed_position(seed_depot())

    response = client.post(
        "/api/portfolio/snapshot",
        json={
            "date": _weeks_ago(0),
            "rows": [{"position_id": position_id, "value": 1131.16, "deposit": 100.0}],
        },
    )

    assert response.status_code == 200
    rows = _snapshot_rows(position_id)
    assert len(rows) == 1
    assert rows[0]["value"] == 1131.16
    assert rows[0]["deposit"] == 100.0
    assert rows[0]["carried"] == 0


def test_post_snapshot_carries_an_empty_value_forward(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """A null value repeats the previous week and marks the row as carried."""
    position_id = seed_position(seed_depot())
    seed_snapshot(position_id, _weeks_ago(1), 1000.0)

    client.post(
        "/api/portfolio/snapshot",
        json={
            "date": _weeks_ago(0),
            "rows": [{"position_id": position_id, "value": None, "deposit": None}],
        },
    )

    latest = _snapshot_rows(position_id)[-1]
    assert latest["value"] == 1000.0
    assert latest["deposit"] == 0.0
    assert latest["carried"] == 1


def test_post_snapshot_inherits_the_previous_fx_rate(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """A USD position keeps its rate without the form having to send one."""
    position_id = seed_position(seed_depot(), currency="USD")
    seed_snapshot(position_id, _weeks_ago(1), 1080.0, fx_rate=1.08)

    client.post(
        "/api/portfolio/snapshot",
        json={
            "date": _weeks_ago(0),
            "rows": [{"position_id": position_id, "value": 1100.0}],
        },
    )

    assert _snapshot_rows(position_id)[-1]["fx_rate"] == 1.08


def test_post_snapshot_accepts_an_explicit_fx_rate(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """An explicit rate overrides the inherited one."""
    position_id = seed_position(seed_depot(), currency="USD")
    seed_snapshot(position_id, _weeks_ago(1), 1080.0, fx_rate=1.08)

    client.post(
        "/api/portfolio/snapshot",
        json={
            "date": _weeks_ago(0),
            "rows": [
                {"position_id": position_id, "value": 1100.0, "fx_rate": 1.12},
            ],
        },
    )

    assert _snapshot_rows(position_id)[-1]["fx_rate"] == 1.12


def test_post_snapshot_is_idempotent_per_position_and_date(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """Re-posting a date corrects that week instead of duplicating it.

    The counter-check for this part: if the ON CONFLICT target is wrong, the
    user's weekly correction silently becomes a second row for the same week.
    """
    position_id = seed_position(seed_depot())
    body: dict[str, Any] = {
        "date": _weeks_ago(0),
        "rows": [{"position_id": position_id, "value": 1000.0}],
    }

    assert client.post("/api/portfolio/snapshot", json=body).status_code == 200
    body["rows"][0]["value"] = 1250.0
    assert client.post("/api/portfolio/snapshot", json=body).status_code == 200

    rows = _snapshot_rows(position_id)
    assert len(rows) == 1
    assert rows[0]["value"] == 1250.0


def test_post_snapshot_rejects_a_carry_without_history(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """There is nothing to carry forward, and a 0 would read as a total loss."""
    position_id = seed_position(seed_depot())

    response = client.post(
        "/api/portfolio/snapshot",
        json={"date": _weeks_ago(0), "rows": [{"position_id": position_id}]},
    )

    assert response.status_code == 400
    assert _snapshot_rows(position_id) == []


def test_post_snapshot_writes_nothing_when_one_row_is_invalid(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """The week is one transaction: a rejected row rolls back the valid ones."""
    depot_id = seed_depot()
    good = seed_position(depot_id, name="Good")
    bad = seed_position(depot_id, name="Bad")
    seed_snapshot(good, _weeks_ago(1), 1000.0)

    response = client.post(
        "/api/portfolio/snapshot",
        json={
            "date": _weeks_ago(0),
            "rows": [
                {"position_id": good, "value": 1100.0},
                {"position_id": bad, "value": None},
            ],
        },
    )

    assert response.status_code == 400
    assert len(_snapshot_rows(good)) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"date": "not-a-date", "rows": [{"position_id": 1, "value": 1.0}]},
        {"date": "2999-01-01", "rows": [{"position_id": 1, "value": 1.0}]},
        {"date": "2026-01-04", "rows": []},
        {"date": "2026-01-04", "rows": [{"position_id": 999, "value": 1.0}]},
        {"date": "2026-01-04", "rows": [{"position_id": 1, "value": "lots"}]},
        {"date": "2026-01-04", "rows": [{"position_id": 1, "fx_rate": 0}]},
    ],
)
def test_post_snapshot_rejects_malformed_payloads(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    body: dict[str, Any],
) -> None:
    """A bad date, an empty batch, an unknown position or a bad number is a 400."""
    seed_position(seed_depot())

    assert client.post("/api/portfolio/snapshot", json=body).status_code == 400


# --- Positions and depots ---------------------------------------------------


def test_post_position_creates_it(client: FlaskClient, seed_depot: SeedDepot) -> None:
    """A created position shows up in the portfolio response."""
    depot_id = seed_depot()

    response = client.post(
        "/api/portfolio/positions",
        json={"depot_id": depot_id, "name": "MSCI World SRI", "kind": "etf"},
    )

    assert response.status_code == 200
    assert response.get_json()["id"] is not None
    payload = client.get("/api/portfolio").get_json()
    assert _position_names(payload) == ["MSCI World SRI"]
    assert payload["depots"][0]["positions"][0]["currency"] == "EUR"


def test_post_position_normalizes_the_currency(
    client: FlaskClient, seed_depot: SeedDepot
) -> None:
    """A lower-case code is stored upper-case."""
    depot_id = seed_depot()

    client.post(
        "/api/portfolio/positions",
        json={"depot_id": depot_id, "name": "FTSE", "kind": "etf", "currency": "usd"},
    )

    payload = client.get("/api/portfolio").get_json()
    assert payload["depots"][0]["positions"][0]["currency"] == "USD"


@pytest.mark.parametrize(
    "overrides",
    [
        {"kind": "crypto"},
        {"name": "   "},
        {"currency": "EURO"},
        {"depot_id": 999},
    ],
)
def test_post_position_rejects_invalid_input(
    client: FlaskClient, seed_depot: SeedDepot, overrides: dict[str, Any]
) -> None:
    """An unknown kind, an empty name, a bad code or a missing depot is a 400."""
    body: dict[str, Any] = {
        "depot_id": seed_depot(),
        "name": "MSCI World SRI",
        "kind": "etf",
    }
    body.update(overrides)

    assert client.post("/api/portfolio/positions", json=body).status_code == 400


def test_post_position_rejects_a_duplicate_name_in_the_same_depot(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """A UNIQUE violation is the client's fault, so it answers 409, not 500."""
    depot_id = seed_depot()
    seed_position(depot_id, name="MSCI World SRI")

    response = client.post(
        "/api/portfolio/positions",
        json={"depot_id": depot_id, "name": "MSCI World SRI", "kind": "etf"},
    )

    assert response.status_code == 409
    assert "MSCI World SRI" in response.get_json()["error"]


def test_post_position_clears_the_previous_benchmark_fallback(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """Exactly one position may be the fallback, or the line depends on row order."""
    depot_id = seed_depot()
    seed_position(depot_id, name="Old", is_benchmark_fallback=True)

    client.post(
        "/api/portfolio/positions",
        json={
            "depot_id": depot_id,
            "name": "New",
            "kind": "etf",
            "is_benchmark_fallback": True,
        },
    )

    payload = client.get("/api/portfolio").get_json()
    flagged = [
        position["name"]
        for depot in payload["depots"]
        for position in depot["positions"]
        if position["is_benchmark_fallback"]
    ]
    assert flagged == ["New"]


def test_patch_position_renames_without_touching_other_columns(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """A partial update leaves every field the client did not mention alone."""
    position_id = seed_position(seed_depot(), name="Old name", currency="USD")

    response = client.patch(
        f"/api/portfolio/positions/{position_id}", json={"name": "New name"}
    )

    assert response.status_code == 200
    position = client.get("/api/portfolio").get_json()["depots"][0]["positions"][0]
    assert position["name"] == "New name"
    assert position["currency"] == "USD"
    assert position["kind"] == "etf"


def test_patch_position_closes_it_and_it_leaves_the_allocation(
    client: FlaskClient,
    seed_depot: SeedDepot,
    seed_position: SeedPosition,
    seed_snapshot: SeedSnapshot,
) -> None:
    """Closing is the one place closed_at differs from deleted_at over HTTP."""
    depot_id = seed_depot()
    held = seed_position(depot_id, name="Held")
    sold = seed_position(depot_id, name="Sold")
    seed_snapshot(held, _weeks_ago(1), 1500.0)
    seed_snapshot(sold, _weeks_ago(1), 500.0)

    assert (
        client.patch(
            f"/api/portfolio/positions/{sold}", json={"close": True}
        ).status_code
        == 200
    )

    payload = client.get("/api/portfolio").get_json()
    assert [entry["label"] for entry in payload["allocation"]] == ["Held"]
    assert payload["totals"]["value_eur"] == 2000.0


def test_patch_position_reopens_a_closed_one(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """close: false clears closed_at, so a mistaken close is reversible."""
    position_id = seed_position(seed_depot(), closed_at="2026-01-31")

    client.patch(f"/api/portfolio/positions/{position_id}", json={"close": False})

    position = client.get("/api/portfolio").get_json()["depots"][0]["positions"][0]
    assert position["is_closed"] is False


def test_patch_position_rejects_an_empty_body(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """A PATCH that names no field is a mistake, not a no-op."""
    position_id = seed_position(seed_depot())

    assert (
        client.patch(f"/api/portfolio/positions/{position_id}", json={}).status_code
        == 400
    )


def test_patch_unknown_position_is_not_found(client: FlaskClient) -> None:
    """An unknown id answers 404 rather than silently updating nothing."""
    assert (
        client.patch("/api/portfolio/positions/999", json={"name": "x"}).status_code
        == 404
    )


def test_patch_position_rejects_an_unknown_depot(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """Moving a position into a depot that does not exist is a 400, not a collision."""
    position_id = seed_position(seed_depot())

    response = client.patch(
        f"/api/portfolio/positions/{position_id}", json={"depot_id": 999}
    )

    assert response.status_code == 400


def test_patch_position_rejects_a_duplicate_name_in_the_same_depot(
    client: FlaskClient, seed_depot: SeedDepot, seed_position: SeedPosition
) -> None:
    """Renaming onto a sibling's name is still the 409 the handler claims."""
    depot_id = seed_depot()
    seed_position(depot_id, name="MSCI World SRI")
    position_id = seed_position(depot_id, name="FTSE All-World")

    response = client.patch(
        f"/api/portfolio/positions/{position_id}", json={"name": "MSCI World SRI"}
    )

    assert response.status_code == 409


def test_post_depot_creates_it(client: FlaskClient) -> None:
    """A created depot shows up as an empty group."""
    response = client.post("/api/portfolio/depots", json={"name": "Trade Republic"})

    assert response.status_code == 200
    payload = client.get("/api/portfolio").get_json()
    assert [depot["name"] for depot in payload["depots"]] == ["Trade Republic"]
    assert payload["depots"][0]["positions"] == []


def test_post_depot_rejects_a_duplicate_name(
    client: FlaskClient, seed_depot: SeedDepot
) -> None:
    """Depot names are unique, and the collision is reported as such."""
    seed_depot(name="Deka")

    response = client.post("/api/portfolio/depots", json={"name": "Deka"})

    assert response.status_code == 409


def test_post_depot_rejects_an_empty_name(client: FlaskClient) -> None:
    """A blank name is a 400."""
    assert client.post("/api/portfolio/depots", json={"name": "  "}).status_code == 400
