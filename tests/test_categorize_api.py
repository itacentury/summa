"""Integration tests for the AI categorize-suggest route (Anthropic call mocked)."""

from typing import Any

import pytest
from flask.testing import FlaskClient

from summa import ai, db
from summa.routes import invoices as invoices_route
from tests.conftest import DB_ERROR_DETAIL, SeedInvoice, broken_db_cursor


def _enable_ai(monkeypatch: pytest.MonkeyPatch) -> None:
    """Enable AI suggestions with a test API key for endpoint happy paths."""
    monkeypatch.setenv("ENABLE_AI_SUGGESTIONS", "1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")


def _stub_suggestions(
    monkeypatch: pytest.MonkeyPatch,
) -> list[list[dict[str, Any]]]:
    """Patch suggest_categories to echo a category per invoice; capture its input.

    Returns a one-element list that will hold the invoices the route passed, so a
    test can assert on exactly which invoices were sent to the model.
    """
    captured: list[list[dict[str, Any]]] = []

    def _fake(
        invoices: list[dict[str, Any]], existing_categories: list[str], model: str
    ) -> list[ai.CategorySuggestion]:
        captured.append(invoices)
        return [
            ai.CategorySuggestion(
                invoice_id=invoice["id"], category="Guessed", is_new=True
            )
            for invoice in invoices
        ]

    monkeypatch.setattr(invoices_route, "suggest_categories", _fake)
    return captured


def test_returns_503_without_api_key(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no ANTHROPIC_API_KEY the endpoint reports it is not configured."""
    monkeypatch.setenv("ENABLE_AI_SUGGESTIONS", "1")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    response = client.post("/api/invoices/categorize-suggest")

    assert response.status_code == 503
    assert response.get_json()["error"] == "AI categorization not configured"


def test_returns_503_when_master_switch_is_disabled(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A disabled master switch hard-disables the endpoint even with a key."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("ENABLE_AI_SUGGESTIONS", "0")

    response = client.post("/api/invoices/categorize-suggest")

    assert response.status_code == 503
    assert response.get_json()["error"] == "AI categorization not configured"


def test_database_error_returns_generic_500(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A database failure is logged, not echoed: the body names no table."""
    _enable_ai(monkeypatch)
    monkeypatch.setattr(invoices_route, "db_cursor", broken_db_cursor)

    response = client.post("/api/invoices/categorize-suggest", json={"ids": [1]})

    assert response.status_code == 500
    assert response.get_json() == {"success": False, "error": "Internal server error"}
    assert DB_ERROR_DETAIL not in response.get_data(as_text=True)


def test_model_failure_returns_its_message_as_502(
    client: FlaskClient, seed_invoice: SeedInvoice, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A model failure reaches the client as the error's user-facing message."""
    _enable_ai(monkeypatch)

    def _fail(*_: Any, **__: Any) -> list[ai.CategorySuggestion]:
        raise ai.AiCategorizationError("Claude request failed")

    monkeypatch.setattr(invoices_route, "suggest_categories", _fail)
    invoice_id = seed_invoice(category=None)

    response = client.post(
        "/api/invoices/categorize-suggest", json={"ids": [invoice_id]}
    )

    assert response.status_code == 502
    assert response.get_json()["error"] == "Claude request failed"


def test_only_uncategorized_are_sent(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only invoices with a NULL category are collected for suggestion."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)

    uncategorized_id = seed_invoice(
        store="Bakery",
        category=None,
        total=14.5,
        items=[{"item_name": "Bread", "item_price": 3.9}],
    )
    categorized_id = seed_invoice(store="Shop", category="Groceries", total=5.0)

    response = client.post(
        "/api/invoices/categorize-suggest",
        json={"ids": [uncategorized_id, categorized_id]},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["count"] == 1
    assert body["total"] == 1
    suggestion = body["suggestions"][0]
    assert suggestion["invoice_id"] == uncategorized_id
    assert suggestion["store"] == "Bakery"
    assert suggestion["total"] == 14.5
    assert suggestion["category"] == "Guessed"
    assert suggestion["is_new"] is True
    assert suggestion["items"] == [{"item_name": "Bread", "item_price": 3.9}]
    # Only the uncategorized invoice reached the model.
    assert [invoice["id"] for invoice in captured[0]] == [uncategorized_id]


def test_only_requested_ids_are_scoped(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only invoices whose ids the client sent (the visible page) are collected."""
    _enable_ai(monkeypatch)
    _stub_suggestions(monkeypatch)

    on_page = seed_invoice(store="OnPage", category=None)
    seed_invoice(store="OffPage", category=None)

    response = client.post("/api/invoices/categorize-suggest", json={"ids": [on_page]})

    body = response.get_json()
    assert body["count"] == 1
    assert body["suggestions"][0]["invoice_id"] == on_page


def test_soft_deleted_ids_are_excluded(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A soft-deleted id in the request is excluded from both count and analysis."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)

    visible_id = seed_invoice(store="Bakery", category=None)
    deleted_id = seed_invoice(store="Gone", category=None, deleted=True)

    response = client.post(
        "/api/invoices/categorize-suggest",
        json={"ids": [visible_id, deleted_id]},
    )

    body = response.get_json()
    assert body["count"] == 1
    assert body["total"] == 1  # the deleted row is filtered out of COUNT too
    assert [invoice["id"] for invoice in captured[0]] == [visible_id]


def test_run_is_capped_and_reports_total(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """More than the cap: only the first CATEGORIZE_SUGGEST_LIMIT are sent, `total` reports the full set."""
    _enable_ai(monkeypatch)
    monkeypatch.setattr(invoices_route, "CATEGORIZE_SUGGEST_LIMIT", 3)
    captured = _stub_suggestions(monkeypatch)

    ids = [seed_invoice(store=f"Store {index}", category=None) for index in range(5)]

    response = client.post("/api/invoices/categorize-suggest", json={"ids": ids})

    body = response.get_json()
    assert body["total"] == 5
    assert body["count"] == 3
    assert len(captured[0]) == 3


def test_large_id_list_is_chunked(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An id list spanning several chunks is counted and ordered correctly."""
    _enable_ai(monkeypatch)
    # Force multiple chunks (size 2) and a small cap so the cross-chunk merge and
    # the global ORDER BY id LIMIT are both exercised without seeding 900+ rows.
    monkeypatch.setattr(invoices_route, "chunked", lambda items: db.chunked(items, 2))
    monkeypatch.setattr(invoices_route, "CATEGORIZE_SUGGEST_LIMIT", 3)
    captured = _stub_suggestions(monkeypatch)

    ids = [seed_invoice(store=f"Store {index}", category=None) for index in range(5)]

    response = client.post("/api/invoices/categorize-suggest", json={"ids": ids})

    body = response.get_json()
    assert body["total"] == 5  # summed across chunks
    assert body["count"] == 3  # capped
    # The three lowest ids overall, merged correctly across chunk boundaries.
    assert [invoice["id"] for invoice in captured[0]] == sorted(ids)[:3]


def test_no_uncategorized_returns_empty(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A page of only categorized invoices returns an empty result, no API call."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)
    categorized_id = seed_invoice(store="Shop", category="Groceries")

    response = client.post(
        "/api/invoices/categorize-suggest", json={"ids": [categorized_id]}
    )

    assert response.get_json() == {"suggestions": [], "count": 0, "total": 0}
    assert captured == []  # suggest_categories was never called


def test_empty_ids_returns_empty(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No ids (empty page) returns an empty result without touching the DB or model."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)

    response = client.post("/api/invoices/categorize-suggest", json={"ids": []})

    assert response.get_json() == {"suggestions": [], "count": 0, "total": 0}
    assert captured == []


def test_missing_body_returns_empty(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A body-less POST is treated like an empty page, not as a malformed payload."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)

    response = client.post("/api/invoices/categorize-suggest")

    assert response.status_code == 200
    assert response.get_json() == {"suggestions": [], "count": 0, "total": 0}
    assert captured == []


@pytest.mark.parametrize(
    "payload",
    [
        {"ids": "abc"},
        {"ids": 5},
        {"ids": 0},
        {"ids": ""},
        {"ids": {}},
        {"ids": [None]},
        {"ids": [1.9]},
        {"ids": [True]},
        {"nope": [1]},
        {},
        [1, 2],
    ],
)
def test_malformed_ids_return_400(
    client: FlaskClient,
    monkeypatch: pytest.MonkeyPatch,
    payload: Any,
) -> None:
    """A malformed ids body is a client error, not a silent empty success."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)

    response = client.post("/api/invoices/categorize-suggest", json=payload)

    assert response.status_code == 400
    assert captured == []  # never reached the model


def test_malformed_json_body_returns_400(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unparseable body is a client error -- only an *absent* body means empty page."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)

    response = client.post(
        "/api/invoices/categorize-suggest",
        data="{",
        content_type="application/json",
    )

    assert response.status_code == 400
    assert captured == []


def test_second_call_reuses_cache(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unchanged invoices are served from cache: the model is called only once."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)
    invoice_id = seed_invoice(store="Bakery", category=None)

    payload: dict[str, Any] = {"ids": [invoice_id]}
    first = client.post("/api/invoices/categorize-suggest", json=payload).get_json()
    second = client.post("/api/invoices/categorize-suggest", json=payload).get_json()

    # Identical response both times; the model was called only for the first.
    assert first == second
    assert len(captured) == 1  # the second call hit the cache, no model call


def test_edited_invoice_is_rechecked(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Changing an invoice's content invalidates its cache entry; only it is re-sent."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)
    stable_id = seed_invoice(store="Bakery", category=None)
    edited_id = seed_invoice(store="Shop", category=None, total=5.0)

    payload: dict[str, Any] = {"ids": [stable_id, edited_id]}
    client.post("/api/invoices/categorize-suggest", json=payload)

    conn = db.get_db()
    conn.execute("UPDATE invoices SET total = 99.0 WHERE id = ?", (edited_id,))
    conn.commit()
    conn.close()

    client.post("/api/invoices/categorize-suggest", json=payload)

    # First call sent both; second sent only the edited invoice (stable one reused).
    assert [invoice["id"] for invoice in captured[0]] == [stable_id, edited_id]
    assert [invoice["id"] for invoice in captured[1]] == [edited_id]


def test_new_invoice_is_rechecked(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A newly added uncategorized invoice is the only one sent on the next call."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)
    existing_id = seed_invoice(store="Bakery", category=None)

    client.post("/api/invoices/categorize-suggest", json={"ids": [existing_id]})
    new_id = seed_invoice(store="Butcher", category=None)
    client.post("/api/invoices/categorize-suggest", json={"ids": [existing_id, new_id]})

    assert [invoice["id"] for invoice in captured[1]] == [new_id]


def test_model_switch_rechecks(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Switching the model invalidates the cache: the invoice is analyzed again."""
    _enable_ai(monkeypatch)
    captured = _stub_suggestions(monkeypatch)
    invoice_id = seed_invoice(store="Bakery", category=None)

    client.post(
        "/api/invoices/categorize-suggest",
        json={"ids": [invoice_id], "model": "haiku"},
    )
    client.post(
        "/api/invoices/categorize-suggest",
        json={"ids": [invoice_id], "model": "opus"},
    )

    assert len(captured) == 2
    assert [invoice["id"] for invoice in captured[1]] == [invoice_id]


@pytest.mark.parametrize("model_key", [5, True, [], {}, None, "gpt-4"])
def test_unusable_model_falls_back_to_the_default(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
    model_key: Any,
) -> None:
    """An unusable model key is not a client error: it silently uses the default."""
    _enable_ai(monkeypatch)
    _stub_suggestions(monkeypatch)
    invoice_id = seed_invoice(store="Bakery", category=None)

    response = client.post(
        "/api/invoices/categorize-suggest",
        json={"ids": [invoice_id], "model": model_key},
    )

    assert response.status_code == 200
    # The cached row carries the resolved model, so it reports what the route picked.
    conn = db.get_db()
    cached = conn.execute(
        "SELECT model FROM invoice_category_suggestions WHERE invoice_id = ?",
        (invoice_id,),
    ).fetchone()
    conn.close()
    assert cached["model"] == ai.MODELS[ai.DEFAULT_MODEL_KEY]


def test_is_new_recomputed_for_cached_suggestion(
    client: FlaskClient,
    seed_invoice: SeedInvoice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """is_new reflects the current category set even when the suggestion is cached."""
    _enable_ai(monkeypatch)
    _stub_suggestions(monkeypatch)  # every suggestion is the category "Guessed"
    invoice_id = seed_invoice(store="Bakery", category=None)

    payload: dict[str, Any] = {"ids": [invoice_id]}
    first = client.post("/api/invoices/categorize-suggest", json=payload).get_json()
    assert first["suggestions"][0]["is_new"] is True

    # "Guessed" now exists as a real category, so the cached suggestion is no longer new.
    seed_invoice(store="Deli", category="Guessed")
    second = client.post("/api/invoices/categorize-suggest", json=payload).get_json()

    assert second["suggestions"][0]["is_new"] is False


def test_categorize_limit_is_fully_budgeted() -> None:
    """The batch cap never exceeds what the AI token budget can fully fund."""
    limit: int = invoices_route.CATEGORIZE_SUGGEST_LIMIT
    assert ai._max_tokens_for(limit) == (
        ai._TOKEN_BUDGET_BASE + ai._TOKENS_PER_INVOICE * limit
    )


def _invoice(invoice_id: int, store: str = "Shop") -> dict[str, Any]:
    """Return an invoice dict shaped like the route assembles it."""
    return {"id": invoice_id, "store": store, "total": 1.0, "items": []}


def test_partition_by_cache_reuses_only_exact_matches() -> None:
    """A hit needs the same fingerprint and model; anything else is a miss."""
    cache = {
        1: invoices_route.CachedSuggestion("Food", "m", "fp1"),
        2: invoices_route.CachedSuggestion("Food", "m", "stale"),
        3: invoices_route.CachedSuggestion("Food", "other", "fp3"),
    }
    invoices = [_invoice(1), _invoice(2), _invoice(3), _invoice(4)]
    fingerprints = {1: "fp1", 2: "fp2", 3: "fp3", 4: "fp4"}

    resolved, misses = invoices_route._partition_by_cache(
        invoices, cache, fingerprints, "m"
    )

    assert resolved == {1: "Food"}
    assert [invoice["id"] for invoice in misses] == [2, 3, 4]


def test_build_suggestions_keeps_order_and_omits_unresolved() -> None:
    """Suggestions follow load order, skip unanswered invoices and flag new ones."""
    invoices = [_invoice(1, "A"), _invoice(2, "B"), _invoice(3, "C")]

    suggestions = invoices_route._build_suggestions(
        invoices, {3: "Food", 1: "Travel"}, {"food"}
    )

    assert [(s["invoice_id"], s["category"], s["is_new"]) for s in suggestions] == [
        (1, "Travel", True),
        (3, "Food", False),
    ]
    assert suggestions[0]["store"] == "A"
