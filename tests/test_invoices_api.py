"""Integration tests for the invoice CRUD, bulk and lookup endpoints."""

from copy import deepcopy
from datetime import date, timedelta
from typing import Any

import pytest
from flask.testing import FlaskClient

from summa import db, helpers
from summa.routes import invoices as invoices_route
from tests.conftest import DB_ERROR_DETAIL, SeedInvoice, broken_db_cursor


def _get_json(response: Any) -> Any:
    """Return the parsed JSON body of a test-client response."""
    return response.get_json()


def _list(client: FlaskClient, query: str = "") -> Any:
    """Return the invoices array from a GET /api/invoices response."""
    return _get_json(client.get(f"/api/invoices{query}"))["invoices"]


def _detail(client: FlaskClient, invoice_id: int) -> Any:
    """Return the parsed body of the single-invoice detail endpoint."""
    return _get_json(client.get(f"/api/invoices/{invoice_id}"))


def _invoice_payload() -> dict[str, Any]:
    """Return a valid invoice payload used as baseline in validation tests."""
    return {
        "date": "2024-03-01",
        "store": "Grocer",
        "category": "Food",
        "total": 25.5,
        "items": [{"item_name": "Milk", "item_price": 1.5}],
    }


def _payload_with(field: str, value: Any, *, missing: bool = False) -> dict[str, Any]:
    """Return a payload with one overridden (or removed) top-level/item field."""
    payload: dict[str, Any] = deepcopy(_invoice_payload())
    if field in {"item_name", "item_price"}:
        target: dict[str, Any] = payload["items"][0]
    else:
        target = payload
    if missing:
        target.pop(field)
    else:
        target[field] = value
    return payload


_FIELD_VALIDATION_CASES: list[tuple[str, Any, str]] = [
    ("date", "", "Field 'date' cannot be empty"),
    ("date", "   ", "Field 'date' cannot be empty"),
    ("date", None, "Field 'date' must be a string"),
    ("store", "", "Field 'store' cannot be empty"),
    ("store", "   ", "Field 'store' cannot be empty"),
    ("store", None, "Field 'store' must be a string"),
    ("total", "abc", "Field 'total' must be a number"),
    ("total", None, "Field 'total' must be a number"),
    ("total", float("inf"), "Field 'total' must be a finite number"),
    ("total", float("nan"), "Field 'total' must be a finite number"),
    ("items", "bad", "Field 'items' must be a list"),
    ("item_name", "", "Field 'item_name' cannot be empty"),
    ("item_name", "   ", "Field 'item_name' cannot be empty"),
    ("item_name", None, "Field 'item_name' must be a string"),
    ("item_price", "abc", "Field 'item_price' must be a number"),
    ("item_price", None, "Field 'item_price' must be a number"),
    ("item_price", float("-inf"), "Field 'item_price' must be a finite number"),
    ("category", ["bad"], "Field 'category' must be a string"),
]

_MISSING_FIELD_VALIDATION_CASES: list[tuple[str, str]] = [
    ("date", "Missing required field: date"),
    ("store", "Missing required field: store"),
    ("total", "Missing required field: total"),
    ("item_name", "Missing required field: item_name"),
    ("item_price", "Missing required field: item_price"),
]


def _valid_items() -> list[dict[str, Any]]:
    """Return a minimal valid items list for invoice API payloads."""
    return [{"item_name": "Line item", "item_price": 1.0}]


@pytest.mark.parametrize("path", ["create", "update", "import"])
def test_write_paths_clean_category(
    client: FlaskClient, seed_invoice: SeedInvoice, path: str
) -> None:
    """Create, update and import all collapse and length-cap the category."""
    payload: dict[str, Any] = _payload_with("category", "Food\n\nStuff" + "x" * 200)
    if path == "create":
        client.post("/api/invoices", json=payload)
    elif path == "update":
        client.put(f"/api/invoices/{seed_invoice()}", json=payload)
    else:
        client.post("/api/invoices/import", json=[payload])

    stored: str = _list(client)[0]["category"]
    assert stored.startswith("Food Stuff")
    assert len(stored) <= helpers.MAX_CATEGORY_LENGTH


# --- POST /api/invoices -------------------------------------------------------


def test_add_invoice_creates_invoice_with_items(client: FlaskClient) -> None:
    """A valid payload creates the invoice and its items and returns the new id."""
    response = client.post(
        "/api/invoices",
        json={
            "date": "2024-03-01",
            "store": "Grocer",
            "category": "Food",
            "total": 25.5,
            "items": [
                {"item_name": "Milk", "item_price": 1.5},
                {"item_name": "Bread", "item_price": 2.0},
            ],
        },
    )

    assert response.status_code == 200
    body = _get_json(response)
    assert body["success"] is True
    assert isinstance(body["id"], int)

    listed = _list(client)
    assert len(listed) == 1
    assert listed[0]["store"] == "Grocer"
    # The compact list omits items; they are served by the detail endpoint.
    assert "items" not in listed[0]
    assert len(_detail(client, body["id"])["items"]) == 2


def test_list_omits_items(client: FlaskClient, seed_invoice: SeedInvoice) -> None:
    """The list payload never includes line items (loaded on demand instead)."""
    seed_invoice(items=[{"item_name": "apple", "item_price": 1.0}])

    assert "items" not in _list(client)[0]


def test_get_invoice_detail_returns_items(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """The detail endpoint returns an invoice with its own line items."""
    seed_invoice(
        store="First",
        items=[{"item_name": "apple", "item_price": 1.0}],
    )
    second_id = seed_invoice(
        store="Second",
        items=[
            {"item_name": "bread", "item_price": 2.0},
            {"item_name": "cheese", "item_price": 3.0},
        ],
    )

    detail = _detail(client, second_id)
    assert detail["store"] == "Second"
    assert [item["item_name"] for item in detail["items"]] == ["bread", "cheese"]


def test_get_invoice_detail_unknown_returns_404(client: FlaskClient) -> None:
    """A detail request for a non-existent id returns 404."""
    assert client.get("/api/invoices/999").status_code == 404


def test_get_invoice_detail_soft_deleted_returns_404(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """A soft-deleted invoice is treated as absent by the detail endpoint."""
    invoice_id = seed_invoice(deleted=True)

    assert client.get(f"/api/invoices/{invoice_id}").status_code == 404


def test_add_invoice_strips_whitespace(client: FlaskClient) -> None:
    """strip_text normalizes surrounding whitespace on text fields."""
    client.post(
        "/api/invoices",
        json={
            "date": "  2024-03-01  ",
            "store": "  Spaced Store  ",
            "category": "  Cat  ",
            "total": 5,
            "items": _valid_items(),
        },
    )

    invoice = _list(client)[0]
    assert invoice["date"] == "2024-03-01"
    assert invoice["store"] == "Spaced Store"
    assert invoice["category"] == "Cat"


def test_add_invoice_rejects_empty_items(client: FlaskClient) -> None:
    """An invoice without items is rejected."""
    response = client.post(
        "/api/invoices",
        json={"date": "2024-03-01", "store": "NoItems", "total": 3.0, "items": []},
    )
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Invoice must contain at least one item"
    assert _list(client) == []


def test_add_invoice_null_items_is_rejected(client: FlaskClient) -> None:
    """An explicit null items value is rejected as malformed."""
    response = client.post(
        "/api/invoices",
        json={"date": "2024-03-01", "store": "NullItems", "total": 3.0, "items": None},
    )
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Field 'items' must be a list"
    assert _list(client) == []


def test_add_invoice_missing_field_returns_400(client: FlaskClient) -> None:
    """A missing required key is rejected with the JSON 400 envelope."""
    response = client.post("/api/invoices", json={"store": "NoDate", "total": 1.0})
    assert response.status_code == 400
    body = _get_json(response)
    assert body["success"] is False
    assert body["error"] == "Missing required field: date"


def test_add_invoice_non_numeric_total_returns_400(client: FlaskClient) -> None:
    """A non-numeric total is rejected with the JSON 400 envelope."""
    response = client.post(
        "/api/invoices",
        json={
            "date": "2024-03-01",
            "store": "Shop",
            "total": "abc",
            "items": _valid_items(),
        },
    )
    assert response.status_code == 400
    body = _get_json(response)
    assert body["success"] is False
    assert body["error"] == "Field 'total' must be a number"


def test_add_invoice_non_string_store_returns_400(client: FlaskClient) -> None:
    """A non-string store is rejected with the JSON 400 envelope."""
    response = client.post(
        "/api/invoices",
        json={
            "date": "2024-03-01",
            "store": 123,
            "total": 1.0,
            "items": _valid_items(),
        },
    )
    assert response.status_code == 400
    body = _get_json(response)
    assert body["success"] is False
    assert body["error"] == "Field 'store' must be a string"


def test_add_invoice_non_string_category_returns_400(client: FlaskClient) -> None:
    """A non-string category is rejected with the JSON 400 envelope."""
    response = client.post(
        "/api/invoices",
        json={
            "date": "2024-03-01",
            "store": "Shop",
            "category": ["a"],
            "total": 1.0,
            "items": _valid_items(),
        },
    )
    assert response.status_code == 400
    body = _get_json(response)
    assert body["success"] is False
    assert body["error"] == "Field 'category' must be a string"


def test_add_invoice_future_date_returns_400(client: FlaskClient) -> None:
    """A future invoice date is rejected — the app has no future invoices."""
    tomorrow: str = (date.today() + timedelta(days=1)).isoformat()
    response = client.post(
        "/api/invoices",
        json={"date": tomorrow, "store": "Shop", "total": 1.0, "items": _valid_items()},
    )
    assert response.status_code == 400
    body = _get_json(response)
    assert body["success"] is False
    assert body["error"] == "Invoice date cannot be in the future"
    assert _list(client) == []


@pytest.mark.parametrize(
    ("payload", "expected_error"),
    [
        (_payload_with(field, value), message)
        for field, value, message in _FIELD_VALIDATION_CASES
    ]
    + [
        (_payload_with(field, None, missing=True), message)
        for field, message in _MISSING_FIELD_VALIDATION_CASES
    ],
)
def test_add_invoice_field_validation_matrix_returns_400(
    client: FlaskClient,
    payload: dict[str, Any],
    expected_error: str,
) -> None:
    """All field-level validation failures return 400 with a precise message."""
    response = client.post("/api/invoices", json=payload)
    assert response.status_code == 400
    assert _get_json(response)["error"] == expected_error


# --- GET /api/invoices --------------------------------------------------------


def test_get_invoices_excludes_soft_deleted(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Soft-deleted invoices never appear in the listing."""
    seed_invoice(store="Visible")
    seed_invoice(store="Gone", deleted=True)

    stores = [invoice["store"] for invoice in _list(client)]
    assert stores == ["Visible"]


def test_get_invoices_filters_by_store_and_category(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """The store and category query parameters filter on exact matches."""
    seed_invoice(store="Aldi", category="Food")
    seed_invoice(store="Rewe", category="Food")
    seed_invoice(store="Aldi", category="Drinks")

    by_store = _list(client, "?store=Aldi")
    assert len(by_store) == 2

    by_category = _list(client, "?category=Drinks")
    assert len(by_category) == 1
    assert by_category[0]["store"] == "Aldi"


def test_get_invoices_filters_by_date_range(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """date_from and date_to bound the results inclusively."""
    seed_invoice(date="2024-01-01", store="Jan")
    seed_invoice(date="2024-02-01", store="Feb")
    seed_invoice(date="2024-03-01", store="Mar")

    result = _list(client, "?date_from=2024-02-01&date_to=2024-02-28")
    assert [invoice["store"] for invoice in result] == ["Feb"]


def test_get_invoices_search_matches_store_and_item(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """search matches on the store name as well as item names."""
    seed_invoice(store="Banana Stand")
    seed_invoice(store="Other", items=[{"item_name": "banana bread", "item_price": 3}])
    seed_invoice(store="Unrelated", items=[{"item_name": "apple", "item_price": 1}])

    result = _list(client, "?search=banana")
    assert len(result) == 2


def test_get_invoices_search_escapes_like_wildcards(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """LIKE wildcards in the search term match literally, not as wildcards."""
    seed_invoice(store="Sale")
    seed_invoice(store="S_le")

    underscore = _list(client, "?search=S_le")
    assert [invoice["store"] for invoice in underscore] == ["S_le"]

    seed_invoice(store="50")
    seed_invoice(store="50%")

    percent = _list(client, "?search=50%25")
    assert [invoice["store"] for invoice in percent] == ["50%"]


def test_get_invoices_default_sort_is_date_desc(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Without sort_by the listing defaults to date descending."""
    seed_invoice(date="2024-02-01", store="Feb")
    seed_invoice(date="2024-01-01", store="Jan")
    seed_invoice(date="2024-03-01", store="Mar")

    dates = [invoice["date"] for invoice in _list(client)]
    assert dates == ["2024-03-01", "2024-02-01", "2024-01-01"]


def test_get_invoices_sorting(client: FlaskClient, seed_invoice: SeedInvoice) -> None:
    """sort_by/sort_order order the results by the chosen column."""
    seed_invoice(store="A", total=30.0)
    seed_invoice(store="B", total=10.0)
    seed_invoice(store="C", total=20.0)

    ascending = _list(client, "?sort_by=total&sort_order=asc")
    assert [invoice["total"] for invoice in ascending] == [10.0, 20.0, 30.0]

    descending = _list(client, "?sort_by=total&sort_order=desc")
    assert [invoice["total"] for invoice in descending] == [30.0, 20.0, 10.0]


def test_get_invoices_ignores_unknown_sort_column(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """An out-of-whitelist sort_by is ignored rather than injected into SQL."""
    seed_invoice(store="A", total=1.0)
    seed_invoice(store="B", total=2.0)

    response = client.get("/api/invoices?sort_by=total;DROP TABLE invoices")
    assert response.status_code == 200
    assert len(_get_json(response)["invoices"]) == 2


# --- GET /api/stores and /api/categories --------------------------------------


def test_get_stores_distinct_sorted_without_deleted(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Stores are distinct, alphabetically sorted and exclude deleted rows."""
    seed_invoice(store="Rewe")
    seed_invoice(store="Aldi")
    seed_invoice(store="Aldi")
    seed_invoice(store="Hidden", deleted=True)

    assert _get_json(client.get("/api/stores")) == ["Aldi", "Rewe"]


def test_get_categories_excludes_null_and_deleted(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Categories are distinct, sorted, and skip NULL and deleted rows."""
    seed_invoice(store="A", category="Food")
    seed_invoice(store="B", category=None)
    seed_invoice(store="C", category="Drinks")
    seed_invoice(store="D", category="Hidden", deleted=True)

    assert _get_json(client.get("/api/categories")) == ["Drinks", "Food"]


# --- POST /api/invoices/import ------------------------------------------------


def test_import_skips_duplicates(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Import inserts new rows and skips ones matching date+store+total."""
    seed_invoice(date="2024-01-01", store="Dup", total=10.0)

    response = client.post(
        "/api/invoices/import",
        json=[
            {
                "date": "2024-01-01",
                "store": "Dup",
                "total": 10.0,
                "items": _valid_items(),
            },
            {
                "date": "2024-01-02",
                "store": "New",
                "total": 5.0,
                "items": _valid_items(),
            },
        ],
    )

    body = _get_json(response)
    assert response.status_code == 200
    assert body["imported"] == 1
    assert body["skipped"] == 1
    assert body["failed"] == 0
    assert body["errors"] == []
    assert len(_list(client)) == 2


def test_import_skips_duplicates_within_the_batch(client: FlaskClient) -> None:
    """A repeat inside one batch is skipped like a match already stored."""
    entry: dict[str, Any] = {
        "date": "2024-01-01",
        "store": "Twice",
        "total": 10.0,
        "items": _valid_items(),
    }

    body = _get_json(client.post("/api/invoices/import", json=[entry, entry]))

    assert (body["imported"], body["skipped"]) == (1, 1)
    assert len(_list(client)) == 1


def test_import_reimports_soft_deleted_invoice(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """A soft-deleted invoice no longer blocks re-importing the same entry."""
    seed_invoice(date="2024-01-01", store="Gone", total=10.0, deleted=True)

    response = client.post(
        "/api/invoices/import",
        json=[
            {
                "date": "2024-01-01",
                "store": "Gone",
                "total": 10.0,
                "items": _valid_items(),
            }
        ],
    )

    body = _get_json(response)
    assert response.status_code == 200
    assert body["imported"] == 1
    assert body["skipped"] == 0
    assert [invoice["store"] for invoice in _list(client)] == ["Gone"]


def test_import_invalid_entry_reports_partial_success(client: FlaskClient) -> None:
    """A lone invalid entry no longer aborts the batch: 200 with an indexed error."""
    response = client.post(
        "/api/invoices/import",
        json=[{"date": "2024-01-01", "store": "Bad", "total": "abc"}],
    )
    assert response.status_code == 200
    body = _get_json(response)
    assert body["imported"] == 0
    assert body["failed"] == 1
    assert body["errors"][0]["index"] == 0
    assert body["errors"][0]["field"] == "total"
    assert body["errors"][0]["message"] == "Field 'total' must be a number"
    assert _list(client) == []


def test_import_rejects_entry_with_empty_items(client: FlaskClient) -> None:
    """An import entry with no items is rejected as a per-entry validation error."""
    response = client.post(
        "/api/invoices/import",
        json=[
            {
                "date": "2024-01-01",
                "store": "Good",
                "total": 5.0,
                "items": _valid_items(),
            },
            {"date": "2024-01-02", "store": "Bad", "total": 7.0, "items": []},
        ],
    )
    assert response.status_code == 200
    body = _get_json(response)
    assert body["imported"] == 1
    assert body["failed"] == 1
    assert body["errors"][0]["index"] == 1
    assert body["errors"][0]["field"] == "items"
    assert body["errors"][0]["message"] == "Invoice must contain at least one item"


def test_import_mixed_entries_imports_only_valid(client: FlaskClient) -> None:
    """A mix of valid and invalid entries imports the valid ones and reports the rest."""
    response = client.post(
        "/api/invoices/import",
        json=[
            {
                "date": "2024-01-01",
                "store": "Good",
                "total": 5.0,
                "items": _valid_items(),
            },
            {"store": "NoDate", "total": 1.0},
            {
                "date": "2024-01-03",
                "store": "AlsoGood",
                "total": 7.0,
                "items": _valid_items(),
            },
        ],
    )
    assert response.status_code == 200
    body = _get_json(response)
    assert body["imported"] == 2
    assert body["failed"] == 1
    assert body["errors"][0]["index"] == 1
    assert body["errors"][0]["field"] == "date"
    stores = {invoice["store"] for invoice in _list(client)}
    assert stores == {"Good", "AlsoGood"}


def test_import_collects_multiple_indexed_errors(client: FlaskClient) -> None:
    """Every invalid entry is reported with its own array index."""
    response = client.post(
        "/api/invoices/import",
        json=[
            {"date": "2024-01-01", "store": "Bad", "total": "abc"},
            {
                "date": "2024-01-02",
                "store": "Good",
                "total": 5.0,
                "items": _valid_items(),
            },
            {"store": "NoDate", "total": 1.0},
        ],
    )
    body = _get_json(response)
    assert body["imported"] == 1
    assert body["failed"] == 2
    assert [error["index"] for error in body["errors"]] == [0, 2]


def test_import_counts_skipped_imported_and_failed_together(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """A duplicate, a valid and an invalid entry are counted independently."""
    seed_invoice(date="2024-01-01", store="Dup", total=10.0)

    response = client.post(
        "/api/invoices/import",
        json=[
            {
                "date": "2024-01-01",
                "store": "Dup",
                "total": 10.0,
                "items": _valid_items(),
            },
            {
                "date": "2024-01-02",
                "store": "New",
                "total": 5.0,
                "items": _valid_items(),
            },
            {"date": "2024-01-03", "store": "Bad", "total": "abc"},
        ],
    )
    body = _get_json(response)
    assert body["imported"] == 1
    assert body["skipped"] == 1
    assert body["failed"] == 1


def test_import_reimporting_corrected_entries_leaves_others_untouched(
    client: FlaskClient,
) -> None:
    """Re-importing only the corrected entries adds them without duplicating imports."""
    first = client.post(
        "/api/invoices/import",
        json=[
            {
                "date": "2024-01-01",
                "store": "Good",
                "total": 5.0,
                "items": _valid_items(),
            },
            {"date": "2024-01-02", "store": "Bad", "total": "abc"},
        ],
    )
    assert _get_json(first)["imported"] == 1

    # The client corrects the invalid entry and re-sends only that one.
    second = client.post(
        "/api/invoices/import",
        json=[
            {
                "date": "2024-01-02",
                "store": "Bad",
                "total": 3.0,
                "items": _valid_items(),
            }
        ],
    )
    body = _get_json(second)
    assert body["imported"] == 1
    assert body["failed"] == 0
    stores = sorted(invoice["store"] for invoice in _list(client))
    assert stores == ["Bad", "Good"]


def test_import_non_list_payload_returns_400(client: FlaskClient) -> None:
    """A payload that is not a list of invoices is rejected with 400."""
    response = client.post(
        "/api/invoices/import",
        json={"date": "2024-01-01", "store": "Single", "total": 1.0},
    )
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Expected a list of invoices"
    assert _list(client) == []


def test_import_future_dated_entry_reported_and_not_persisted(
    client: FlaskClient,
) -> None:
    """A future-dated entry is collected as a per-entry error; valid siblings import."""
    tomorrow: str = (date.today() + timedelta(days=1)).isoformat()
    response = client.post(
        "/api/invoices/import",
        json=[
            {
                "date": "2024-01-02",
                "store": "Good",
                "total": 5.0,
                "items": _valid_items(),
            },
            {
                "date": tomorrow,
                "store": "Future",
                "total": 2.0,
                "items": _valid_items(),
            },
        ],
    )
    assert response.status_code == 200
    body = _get_json(response)
    assert body["imported"] == 1
    assert body["failed"] == 1
    assert body["errors"][0]["index"] == 1
    assert body["errors"][0]["field"] == "date"
    assert body["errors"][0]["message"] == "Invoice date cannot be in the future"
    stores = [invoice["store"] for invoice in _list(client)]
    assert stores == ["Good"]


@pytest.mark.parametrize(
    ("payload", "expected_field", "expected_message"),
    [
        (_payload_with(field, value), field, message)
        for field, value, message in _FIELD_VALIDATION_CASES
    ]
    + [
        (_payload_with(field, None, missing=True), field, message)
        for field, message in _MISSING_FIELD_VALIDATION_CASES
    ],
)
def test_import_field_validation_matrix_reports_indexed_errors(
    client: FlaskClient,
    payload: dict[str, Any],
    expected_field: str,
    expected_message: str,
) -> None:
    """Import returns per-entry field errors for all malformed field variants."""
    response = client.post("/api/invoices/import", json=[payload])
    assert response.status_code == 200
    body = _get_json(response)
    assert body["imported"] == 0
    assert body["skipped"] == 0
    assert body["failed"] == 1
    assert body["errors"][0]["index"] == 0
    assert body["errors"][0]["field"] == expected_field
    assert body["errors"][0]["message"] == expected_message
    assert _list(client) == []


def test_import_item_entry_must_be_object(client: FlaskClient) -> None:
    """Import rejects non-object item entries with an indexed entry-level error."""
    payload = _invoice_payload()
    payload["items"] = ["bad"]
    response = client.post("/api/invoices/import", json=[payload])
    assert response.status_code == 200
    body = _get_json(response)
    assert body["failed"] == 1
    assert body["errors"][0]["field"] is None
    assert body["errors"][0]["message"] == "Each item must be a JSON object"
    assert _list(client) == []


# --- PUT /api/invoices/<id> ---------------------------------------------------


def test_update_invoice_replaces_items(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Updating an invoice overwrites its fields and fully replaces its items."""
    invoice_id = seed_invoice(
        store="Old", items=[{"item_name": "old item", "item_price": 1.0}]
    )

    response = client.put(
        f"/api/invoices/{invoice_id}",
        json={
            "date": "2024-04-01",
            "store": "New",
            "category": "Updated",
            "total": 42.0,
            "items": [{"item_name": "new item", "item_price": 5.0}],
        },
    )

    assert response.status_code == 200
    invoice = _list(client)[0]
    assert invoice["store"] == "New"
    assert invoice["total"] == 42.0
    detail = _detail(client, invoice_id)
    assert [item["item_name"] for item in detail["items"]] == ["new item"]


@pytest.mark.parametrize(
    ("payload", "expected_error"),
    [
        (_payload_with(field, value), message)
        for field, value, message in _FIELD_VALIDATION_CASES
    ]
    + [
        (_payload_with(field, None, missing=True), message)
        for field, message in _MISSING_FIELD_VALIDATION_CASES
    ],
)
def test_update_invoice_field_validation_matrix_returns_400(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    payload: dict[str, Any],
    expected_error: str,
) -> None:
    """Update mirrors the same field-level validation errors as create/import."""
    invoice_id = seed_invoice(store="Keep")
    response = client.put(f"/api/invoices/{invoice_id}", json=payload)
    assert response.status_code == 400
    assert _get_json(response)["error"] == expected_error


def test_update_nonexistent_invoice_returns_404(client: FlaskClient) -> None:
    """Updating an unknown id is rejected as not found and creates nothing."""
    response = client.put(
        "/api/invoices/999999",
        json={
            "date": "2024-04-01",
            "store": "Ghost",
            "total": 1.0,
            "items": _valid_items(),
        },
    )
    assert response.status_code == 404
    assert _get_json(response)["error"] == "Invoice not found"
    assert _list(client) == []


def test_update_invoice_rejects_empty_items(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Updating with an empty items list is rejected and does not rewrite stored items."""
    invoice_id = seed_invoice(
        store="Keep", items=[{"item_name": "original", "item_price": 1.0}]
    )

    response = client.put(
        f"/api/invoices/{invoice_id}",
        json={"date": "2024-04-01", "store": "New", "total": 42.0, "items": []},
    )
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Invoice must contain at least one item"
    assert [item["item_name"] for item in _detail(client, invoice_id)["items"]] == [
        "original"
    ]


def test_update_soft_deleted_invoice_returns_404(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """A soft-deleted invoice is immutable: PUT returns 404 and its items stay."""
    invoice_id = seed_invoice(
        deleted=True, items=[{"item_name": "original", "item_price": 1.0}]
    )

    response = client.put(
        f"/api/invoices/{invoice_id}",
        json={
            "date": "2024-04-01",
            "store": "New",
            "total": 42.0,
            "items": [{"item_name": "replacement", "item_price": 5.0}],
        },
    )
    assert response.status_code == 404
    assert _get_json(response)["error"] == "Invoice not found"

    # The line items of the deleted invoice must not have been rewritten.
    conn = db.get_db()
    try:
        names = [
            row["item_name"]
            for row in conn.execute(
                "SELECT item_name FROM invoice_items WHERE invoice_id = ?",
                (invoice_id,),
            ).fetchall()
        ]
    finally:
        conn.close()
    assert names == ["original"]


# --- DELETE /api/invoices/<id> ------------------------------------------------


def test_delete_invoice_is_soft(client: FlaskClient, seed_invoice: SeedInvoice) -> None:
    """Delete sets deleted_at but keeps the row physically present."""
    invoice_id = seed_invoice(store="ToDelete")

    response = client.delete(f"/api/invoices/{invoice_id}")
    assert response.status_code == 200
    assert _list(client) == []

    conn = db.get_db()
    try:
        row = conn.execute(
            "SELECT deleted_at FROM invoices WHERE id = ?", (invoice_id,)
        ).fetchone()
    finally:
        conn.close()
    assert row is not None
    assert row["deleted_at"] is not None


def test_delete_soft_deleted_invoice_returns_404(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Deleting an already soft-deleted invoice is rejected as not found."""
    invoice_id = seed_invoice(deleted=True)

    response = client.delete(f"/api/invoices/{invoice_id}")
    assert response.status_code == 404
    assert _get_json(response)["error"] == "Invoice not found"


# --- PUT /api/invoices/bulk-update --------------------------------------------


def test_bulk_update_store_and_category(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Bulk update applies a new store/category to the given ids."""
    first = seed_invoice(store="Old", category="A")
    second = seed_invoice(store="Old", category="A")

    response = client.put(
        "/api/invoices/bulk-update",
        json={"ids": [first, second], "store": "Renamed", "category": "B"},
    )

    body = _get_json(response)
    assert body == {"success": True, "updated": 2}
    stores = {invoice["store"] for invoice in _list(client)}
    assert stores == {"Renamed"}


def test_bulk_update_skips_soft_deleted(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """A soft-deleted id in the set is neither updated nor counted."""
    active = seed_invoice(store="Old")
    deleted = seed_invoice(store="Old", deleted=True)

    response = client.put(
        "/api/invoices/bulk-update",
        json={"ids": [active, deleted], "store": "Renamed"},
    )
    assert _get_json(response) == {"success": True, "updated": 1}

    conn = db.get_db()
    try:
        store = conn.execute(
            "SELECT store FROM invoices WHERE id = ?", (deleted,)
        ).fetchone()["store"]
    finally:
        conn.close()
    assert store == "Old"


def test_bulk_update_empty_category_clears_it(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """An empty-string category is stored as NULL via strip_text."""
    invoice_id = seed_invoice(store="Shop", category="ToClear")

    client.put(
        "/api/invoices/bulk-update",
        json={"ids": [invoice_id], "category": ""},
    )

    assert _list(client)[0]["category"] is None


def test_bulk_update_caps_and_normalizes_category(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """An oversized/whitespace-mangled category is length-capped and collapsed."""
    invoice_id = seed_invoice(store="Shop", category=None)
    raw: str = "  Groceries\n\n" + "x" * 200

    client.put(
        "/api/invoices/bulk-update",
        json={"ids": [invoice_id], "category": raw},
    )

    stored: str = _list(client)[0]["category"]
    assert len(stored) <= helpers.MAX_CATEGORY_LENGTH
    assert "\n" not in stored
    assert stored.startswith("Groceries")


def test_bulk_update_missing_ids_returns_400(client: FlaskClient) -> None:
    """An empty ids list is rejected with 400."""
    response = client.put("/api/invoices/bulk-update", json={"ids": [], "store": "X"})
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Field 'ids' must be a non-empty list"


def test_bulk_update_non_dict_body_returns_json_400(client: FlaskClient) -> None:
    """A list body yields a JSON 400, not an HTML 500 from AttributeError."""
    response = client.put("/api/invoices/bulk-update", json=[1, 2])
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Request body must be a JSON object"


def test_bulk_update_non_int_ids_returns_400(client: FlaskClient) -> None:
    """Ids that are not integers are rejected with a JSON 400."""
    response = client.put(
        "/api/invoices/bulk-update", json={"ids": ["x"], "store": "X"}
    )
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Field 'ids' must contain only integers"


def test_bulk_update_missing_fields_returns_400(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Providing neither store nor category is rejected with 400."""
    invoice_id = seed_invoice()
    response = client.put("/api/invoices/bulk-update", json={"ids": [invoice_id]})
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Missing store or category"


def test_bulk_update_non_string_store_returns_400(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """A non-string store on bulk-update is rejected with a JSON 400."""
    invoice_id = seed_invoice()
    response = client.put(
        "/api/invoices/bulk-update", json={"ids": [invoice_id], "store": 123}
    )
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Field 'store' must be a string"


def test_bulk_update_non_string_category_returns_400(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """A non-string category on bulk-update is rejected with a JSON 400."""
    invoice_id = seed_invoice()
    response = client.put(
        "/api/invoices/bulk-update", json={"ids": [invoice_id], "category": {"x": 1}}
    )
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Field 'category' must be a string"


# --- POST /api/invoices/bulk-delete -------------------------------------------


def test_bulk_delete_soft_deletes_many(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Bulk delete soft-deletes every given id and reports the count."""
    first = seed_invoice(store="A")
    second = seed_invoice(store="B")

    response = client.post("/api/invoices/bulk-delete", json={"ids": [first, second]})

    assert _get_json(response) == {"success": True, "deleted": 2}
    assert _list(client) == []


def test_bulk_delete_skips_already_deleted(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """An already deleted id is neither counted nor has its timestamp rewritten."""
    deleted = seed_invoice(deleted=True)
    original: str = "2020-01-01 00:00:00"
    conn = db.get_db()
    try:
        conn.execute(
            "UPDATE invoices SET deleted_at = ? WHERE id = ?", (original, deleted)
        )
        conn.commit()
    finally:
        conn.close()

    response = client.post("/api/invoices/bulk-delete", json={"ids": [deleted]})
    assert _get_json(response) == {"success": True, "deleted": 0}

    conn = db.get_db()
    try:
        stamp = conn.execute(
            "SELECT deleted_at FROM invoices WHERE id = ?", (deleted,)
        ).fetchone()["deleted_at"]
    finally:
        conn.close()
    assert stamp == original


def test_bulk_delete_logs_a_bounded_id_sample(
    client: FlaskClient, seed_invoice: SeedInvoice, caplog: pytest.LogCaptureFixture
) -> None:
    """The log line names the count and only the first few ids, not the whole list."""
    ids: list[int] = [seed_invoice() for _ in range(8)]

    with caplog.at_level("INFO", logger="summa.routes.invoices"):
        client.post("/api/invoices/bulk-delete", json={"ids": ids})

    message: str = next(
        record.getMessage()
        for record in caplog.records
        if "Bulk soft-delete" in record.getMessage()
    )
    assert "8 of 8" in message
    assert f"first ids={ids[:5]})" in message


def test_bulk_delete_missing_ids_returns_400(client: FlaskClient) -> None:
    """An empty ids list is rejected with 400."""
    response = client.post("/api/invoices/bulk-delete", json={"ids": []})
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Field 'ids' must be a non-empty list"


def test_bulk_delete_non_dict_body_returns_json_400(client: FlaskClient) -> None:
    """A list body yields a JSON 400, not an HTML 500 from AttributeError."""
    response = client.post("/api/invoices/bulk-delete", json=[1, 2])
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Request body must be a JSON object"


def test_bulk_delete_non_int_ids_returns_400(client: FlaskClient) -> None:
    """Ids that are not integers are rejected with a JSON 400."""
    response = client.post("/api/invoices/bulk-delete", json={"ids": ["x"]})
    assert response.status_code == 400
    assert _get_json(response)["error"] == "Field 'ids' must contain only integers"


# --- Non-JSON and malformed bodies --------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/invoices"),
        ("post", "/api/invoices/import"),
        ("put", "/api/invoices/1"),
        ("put", "/api/invoices/bulk-update"),
        ("post", "/api/invoices/bulk-delete"),
    ],
)
def test_non_json_body_returns_json_415(
    client: FlaskClient, method: str, path: str
) -> None:
    """A body that is not JSON gets the JSON error shape instead of an HTML 415."""
    response = getattr(client, method)(path, data="ids=1", content_type="text/plain")
    assert response.status_code == 415
    assert _get_json(response) == {
        "success": False,
        "error": "Request body must be JSON",
    }


def test_malformed_json_body_returns_json_400(client: FlaskClient) -> None:
    """An unparseable JSON body gets the JSON error shape instead of an HTML 400."""
    response = client.post("/api/invoices", data="{", content_type="application/json")
    assert response.status_code == 400
    assert _get_json(response) == {"success": False, "error": "Malformed request"}


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("get", "/api/invoices", None),
        ("post", "/api/invoices", _invoice_payload()),
        ("post", "/api/invoices/import", [_invoice_payload()]),
        ("put", "/api/invoices/1", _invoice_payload()),
        ("delete", "/api/invoices/1", None),
        ("put", "/api/invoices/bulk-update", {"ids": [1], "store": "X"}),
        ("post", "/api/invoices/bulk-delete", {"ids": [1]}),
    ],
)
def test_database_error_returns_generic_500(
    client: FlaskClient,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    body: Any,
) -> None:
    """Any database failure becomes a JSON 500 that names no table or column."""
    monkeypatch.setattr(invoices_route, "db_cursor", broken_db_cursor)

    response = getattr(client, method)(path, json=body)

    assert response.status_code == 500
    assert _get_json(response) == {"success": False, "error": "Internal server error"}
    assert DB_ERROR_DETAIL not in response.get_data(as_text=True)


# --- GET /api/invoices pagination ---------------------------------------------


def test_pagination_defaults_and_totals(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """The default response reports page 1, the page size and full-set totals."""
    for number in range(3):
        seed_invoice(date=f"2024-01-0{number + 1}", store=f"S{number}", total=10.0)

    body = _get_json(client.get("/api/invoices"))
    assert body["page"] == 1
    assert body["page_size"] == 25
    assert body["total_count"] == 3
    assert body["total_sum"] == 30.0
    assert len(body["invoices"]) == 3


def test_pagination_slices_pages_without_overlap(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Sequential pages return disjoint slices covering the whole filtered set."""
    for day in range(1, 6):
        seed_invoice(date=f"2024-01-0{day}", store=f"Store {day}")

    first = _get_json(client.get("/api/invoices?page=1&page_size=2"))
    second = _get_json(client.get("/api/invoices?page=2&page_size=2"))
    third = _get_json(client.get("/api/invoices?page=3&page_size=2"))

    assert [invoice["store"] for invoice in first["invoices"]] == ["Store 5", "Store 4"]
    assert [invoice["store"] for invoice in second["invoices"]] == [
        "Store 3",
        "Store 2",
    ]
    assert [invoice["store"] for invoice in third["invoices"]] == ["Store 1"]
    # total_count stays the full filtered set on every page.
    assert {first["total_count"], second["total_count"], third["total_count"]} == {5}


def test_pagination_clamps_page_size_to_maximum(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """An over-large page_size is clamped to the configured maximum."""
    seed_invoice(store="Only")
    body = _get_json(client.get("/api/invoices?page_size=100000"))
    assert body["page_size"] == 200


def test_pagination_all_returns_every_row_on_one_page(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """page_size=all returns the whole filtered set on page 1, sized to the count."""
    for day in range(1, 6):
        seed_invoice(date=f"2024-01-0{day}", store=f"Store {day}")

    body = _get_json(client.get("/api/invoices?page_size=all"))
    assert body["page"] == 1
    assert body["total_count"] == 5
    assert body["page_size"] == 5
    assert len(body["invoices"]) == 5


def test_pagination_non_numeric_params_fall_back_to_defaults(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Non-numeric page/page_size values fall back to the defaults, not a 500."""
    seed_invoice(store="Only")
    body = _get_json(client.get("/api/invoices?page=abc&page_size=xyz"))
    assert body["page"] == 1
    assert body["page_size"] == 25


def test_pagination_totals_reflect_filters_not_page(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Counts/sums cover the filtered set, and soft-deleted rows are excluded."""
    for day in range(1, 4):
        seed_invoice(date=f"2024-01-0{day}", store="Keep", total=5.0)
    seed_invoice(store="Other", total=99.0)
    seed_invoice(store="Keep", total=1000.0, deleted=True)

    body = _get_json(client.get("/api/invoices?store=Keep&page_size=1"))
    assert body["total_count"] == 3
    assert body["total_sum"] == 15.0
    assert len(body["invoices"]) == 1


def test_uncategorized_count_spans_pages_not_just_the_returned_one(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """The uncategorized tally covers the filtered set, so it is page-independent."""
    seed_invoice(date="2024-01-01", store="A")
    seed_invoice(date="2024-01-02", store="B", category="Groceries")
    seed_invoice(date="2024-01-03", store="C")
    seed_invoice(date="2024-01-04", store="D")

    first = _get_json(client.get("/api/invoices?page=1&page_size=2"))
    second = _get_json(client.get("/api/invoices?page=2&page_size=2"))

    # Each page holds a different share of them; the reported count does not move.
    assert [invoice["category"] for invoice in first["invoices"]] == [None, None]
    assert [invoice["category"] for invoice in second["invoices"]] == [
        "Groceries",
        None,
    ]
    assert first["uncategorized_count"] == 3
    assert second["uncategorized_count"] == 3


def test_uncategorized_count_honours_filters_and_soft_deletes(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """The tally follows the active filters and is 0 for a fully categorized set."""
    seed_invoice(store="Keep")
    seed_invoice(store="Keep", category="Groceries")
    seed_invoice(store="Other")
    seed_invoice(store="Keep", deleted=True)

    assert _get_json(client.get("/api/invoices"))["uncategorized_count"] == 2
    assert _get_json(client.get("/api/invoices?store=Keep"))["uncategorized_count"] == 1
    categorized = client.get("/api/invoices?category=Groceries")
    assert _get_json(categorized)["uncategorized_count"] == 0


# --- GET /api/invoices/ids ----------------------------------------------------


def test_invoice_ids_returns_all_matches_ignoring_pagination(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """The id list covers the whole filtered set regardless of page/page_size."""
    ids = {seed_invoice(store=f"Store {day}") for day in range(1, 6)}

    body = _get_json(client.get("/api/invoices/ids?page=2&page_size=2"))
    assert set(body["ids"]) == ids


def test_invoice_ids_honor_filters(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """store/category/date/search filters narrow the id list identically."""
    keep = seed_invoice(store="Keep", category="Food", date="2024-02-15")
    other = seed_invoice(store="Other", category="Food", date="2024-02-15")
    drinks = seed_invoice(store="Keep", category="Drinks", date="2024-02-15")
    later = seed_invoice(store="Keep", category="Food", date="2024-05-01")

    by_store = _get_json(client.get("/api/invoices/ids?store=Keep&category=Food"))
    assert set(by_store["ids"]) == {keep, later}

    by_date = _get_json(
        client.get("/api/invoices/ids?date_from=2024-02-01&date_to=2024-02-28")
    )
    assert set(by_date["ids"]) == {keep, other, drinks}


def test_invoice_ids_exclude_soft_deleted(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Soft-deleted invoices never appear in the id list."""
    visible = seed_invoice(store="Visible")
    seed_invoice(store="Gone", deleted=True)

    body = _get_json(client.get("/api/invoices/ids"))
    assert body["ids"] == [visible]
