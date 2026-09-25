"""Unit tests for :mod:`summa.ai`, with the Anthropic client fully mocked."""

import json
from typing import Any

import anthropic
import httpx
import pytest

from summa import ai, helpers

_MODEL: str = ai.MODELS[ai.DEFAULT_MODEL_KEY]


def test_suggestions_enabled_defaults_to_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unset master switch keeps AI suggestions disabled."""
    monkeypatch.delenv(ai.ENABLE_ENV, raising=False)

    assert ai.suggestions_enabled() is False


@pytest.mark.parametrize("raw_value", ["", "0", "false", "off", "no"])
def test_suggestions_enabled_recognizes_explicit_false_values(
    monkeypatch: pytest.MonkeyPatch, raw_value: str
) -> None:
    """Explicit falsy strings disable AI suggestions."""
    monkeypatch.setenv(ai.ENABLE_ENV, raw_value)

    assert ai.suggestions_enabled() is False


def test_suggestions_enabled_accepts_truthy_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A truthy switch value keeps AI suggestions enabled."""
    monkeypatch.setenv(ai.ENABLE_ENV, "1")

    assert ai.suggestions_enabled() is True


def test_suggestions_available_requires_switch_and_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Availability is true only when the switch is on and a key exists."""
    monkeypatch.setenv(ai.API_KEY_ENV, "test-key")
    monkeypatch.delenv(ai.ENABLE_ENV, raising=False)

    assert ai.suggestions_available() is False

    monkeypatch.setenv(ai.ENABLE_ENV, "1")

    assert ai.suggestions_available() is True

    monkeypatch.delenv(ai.API_KEY_ENV, raising=False)
    assert ai.suggestions_available() is False

    monkeypatch.setenv(ai.API_KEY_ENV, "test-key")
    monkeypatch.setenv(ai.ENABLE_ENV, "0")
    assert ai.suggestions_available() is False


class _FakeBlock:
    """Minimal stand-in for an Anthropic text content block."""

    def __init__(self, text: str) -> None:
        self.type: str = "text"
        self.text: str = text


class _FakeMessage:
    """Minimal stand-in for an Anthropic message response."""

    def __init__(self, text: str, stop_reason: str = "end_turn") -> None:
        self.content: list[_FakeBlock] = [_FakeBlock(text)]
        self.stop_reason: str = stop_reason


class _FakeMessages:
    """Records the create() call and returns a canned response (or raises)."""

    def __init__(
        self,
        response_text: str | None,
        error: Exception | None,
        stop_reason: str = "end_turn",
    ) -> None:
        self._response_text: str | None = response_text
        self._error: Exception | None = error
        self._stop_reason: str = stop_reason
        self.last_kwargs: dict[str, Any] = {}

    def create(self, **kwargs: Any) -> _FakeMessage:
        self.last_kwargs = kwargs
        if self._error is not None:
            raise self._error
        assert self._response_text is not None
        return _FakeMessage(self._response_text, self._stop_reason)


class _FakeClient:
    """Stand-in for anthropic.Anthropic exposing a `.messages` attribute."""

    def __init__(self, messages: _FakeMessages) -> None:
        self.messages: _FakeMessages = messages


def _patch_client(
    monkeypatch: pytest.MonkeyPatch,
    *,
    response_text: str | None = None,
    error: Exception | None = None,
    stop_reason: str = "end_turn",
) -> _FakeMessages:
    """Patch anthropic.Anthropic to return a fake client; return its messages stub."""
    fake_messages: _FakeMessages = _FakeMessages(response_text, error, stop_reason)
    monkeypatch.setattr(anthropic, "Anthropic", lambda: _FakeClient(fake_messages))
    # The client is cached across calls; drop the cache so this test's patched
    # Anthropic() is the one actually constructed.
    ai._get_client.cache_clear()
    return fake_messages


def test_suggest_categories_builds_request_with_all_invoices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every invoice and the existing categories are sent in one request."""
    response: str = json.dumps(
        {
            "suggestions": [
                {"invoice_id": 1, "category": "Groceries"},
                {"invoice_id": 2, "category": "Gaming"},
            ]
        }
    )
    fake_messages = _patch_client(monkeypatch, response_text=response)

    invoices: list[dict[str, Any]] = [
        {"id": 1, "store": "Bakery", "items": [{"item_name": "Bread"}]},
        {"id": 2, "store": "PlayStation", "items": []},
    ]
    ai.suggest_categories(invoices, ["Groceries"], _MODEL)

    sent: dict[str, Any] = json.loads(
        fake_messages.last_kwargs["messages"][0]["content"]
    )
    assert sent["existing_categories"] == ["Groceries"]
    assert [invoice["id"] for invoice in sent["invoices"]] == [1, 2]
    assert fake_messages.last_kwargs["model"] == _MODEL


def test_is_new_is_computed_case_insensitively(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A suggestion matching an existing category (any case) is not flagged new."""
    response: str = json.dumps(
        {
            "suggestions": [
                {"invoice_id": 1, "category": "groceries"},
                {"invoice_id": 2, "category": "Gaming"},
            ]
        }
    )
    _patch_client(monkeypatch, response_text=response)

    results = ai.suggest_categories(
        [{"id": 1, "store": "A", "items": []}, {"id": 2, "store": "B", "items": []}],
        ["Groceries"],
        _MODEL,
    )

    by_id = {result.invoice_id: result for result in results}
    assert by_id[1].is_new is False  # differs only in casing
    assert by_id[2].is_new is True


def test_category_is_sanitized_and_capped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An oversized/whitespace-mangled model category is collapsed and length-capped."""
    raw: str = "  Groceries\n\n" + "x" * 200
    response: str = json.dumps({"suggestions": [{"invoice_id": 1, "category": raw}]})
    _patch_client(monkeypatch, response_text=response)

    results = ai.suggest_categories(
        [{"id": 1, "store": "A", "items": []}], ["Groceries"], _MODEL
    )

    category = results[0].category
    assert category is not None
    assert len(category) <= helpers.MAX_CATEGORY_LENGTH
    assert "\n" not in category
    assert category.startswith("Groceries")
    # is_new is computed on the cleaned value, which is not an existing category.
    assert results[0].is_new is True


def test_entry_without_invoice_id_is_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A suggestion missing invoice_id is dropped, not fatal to the batch."""
    response: str = json.dumps(
        {
            "suggestions": [
                {"category": "Orphan"},
                {"invoice_id": 2, "category": "Gaming"},
            ]
        }
    )
    _patch_client(monkeypatch, response_text=response)

    results = ai.suggest_categories([{"id": 2, "store": "B", "items": []}], [], _MODEL)

    assert [result.invoice_id for result in results] == [2]


def test_schema_allows_missing_invoice_id() -> None:
    """invoice_id is intentionally optional so the skip-guard stays reachable."""
    item_schema: dict[str, Any] = ai.OUTPUT_SCHEMA["properties"]["suggestions"]["items"]
    assert "invoice_id" not in item_schema["required"]
    assert item_schema["additionalProperties"] is False


def test_api_error_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    """An Anthropic APIError surfaces as AiCategorizationError with a generic message."""
    request: httpx.Request = httpx.Request("POST", "https://api.anthropic.com")
    _patch_client(
        monkeypatch,
        error=anthropic.APIConnectionError(message="boom", request=request),
    )

    with pytest.raises(ai.AiCategorizationError) as caught:
        ai.suggest_categories([{"id": 1, "store": "A", "items": []}], [], _MODEL)
    assert caught.value.message == "Claude request failed"


def test_invalid_json_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-JSON response surfaces as AiCategorizationError."""
    _patch_client(monkeypatch, response_text="not json")

    with pytest.raises(ai.AiCategorizationError):
        ai.suggest_categories([{"id": 1, "store": "A", "items": []}], [], _MODEL)


def test_empty_invoices_short_circuits(monkeypatch: pytest.MonkeyPatch) -> None:
    """No invoices means no request is made and the result is empty."""
    fake_messages = _patch_client(monkeypatch, response_text="{}")

    assert ai.suggest_categories([], [], _MODEL) == []
    assert fake_messages.last_kwargs == {}


def test_truncated_response_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    """A max_tokens stop is reported as truncation, not as invalid JSON."""
    # Valid JSON body, but the model stopped on the token ceiling.
    response: str = json.dumps({"suggestions": []})
    _patch_client(monkeypatch, response_text=response, stop_reason="max_tokens")

    with pytest.raises(ai.AiCategorizationError, match="truncated"):
        ai.suggest_categories([{"id": 1, "store": "A", "items": []}], [], _MODEL)


def test_haiku_disables_thinking_and_omits_effort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default (older) model runs with thinking disabled and no effort."""
    fake_messages = _patch_client(
        monkeypatch, response_text=json.dumps({"suggestions": []})
    )

    ai.suggest_categories(
        [{"id": 1, "store": "A", "items": []}], [], ai.MODELS["haiku"]
    )

    assert fake_messages.last_kwargs["thinking"] == {"type": "disabled"}
    assert "effort" not in fake_messages.last_kwargs["output_config"]


def test_adaptive_model_uses_low_effort_thinking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 4.6+ model gets adaptive thinking and low effort."""
    fake_messages = _patch_client(
        monkeypatch, response_text=json.dumps({"suggestions": []})
    )

    ai.suggest_categories(
        [{"id": 1, "store": "A", "items": []}], [], ai.MODELS["sonnet"]
    )

    assert fake_messages.last_kwargs["thinking"] == {"type": "adaptive"}
    assert fake_messages.last_kwargs["output_config"]["effort"] == "low"


def test_max_tokens_scales_with_batch_and_is_capped() -> None:
    """The token budget grows with the batch but never exceeds the cap."""
    small: int = ai._max_tokens_for(1)
    large: int = ai._max_tokens_for(100)
    assert small < large
    assert large == ai._TOKEN_BUDGET_BASE + 100 * ai._TOKENS_PER_INVOICE
    assert ai._max_tokens_for(100_000) == ai._TOKEN_BUDGET_CAP


def test_fingerprint_is_stable_and_item_order_independent() -> None:
    """Same content yields the same fingerprint regardless of item order."""
    base: dict[str, Any] = {
        "id": 1,
        "store": "Bakery",
        "total": 14.5,
        "items": [
            {"item_name": "Bread", "item_price": 3.9},
            {"item_name": "Milk", "item_price": 1.2},
        ],
    }
    reordered: dict[str, Any] = {**base, "items": list(reversed(base["items"]))}
    assert ai.invoice_fingerprint(base) == ai.invoice_fingerprint(reordered)


def test_fingerprint_changes_when_content_changes() -> None:
    """Editing store, total or an item changes the fingerprint."""
    base: dict[str, Any] = {"id": 1, "store": "Bakery", "total": 14.5, "items": []}
    assert ai.invoice_fingerprint(base) != ai.invoice_fingerprint(
        {**base, "total": 15.0}
    )
    assert ai.invoice_fingerprint(base) != ai.invoice_fingerprint(
        {**base, "store": "Shop"}
    )


def test_is_category_new_is_case_insensitive() -> None:
    """A category is new only if absent from the existing set, ignoring casing."""
    existing: set[str] = {"groceries"}
    assert ai.is_category_new("Travel", existing) is True
    assert ai.is_category_new("Groceries", existing) is False
    assert ai.is_category_new(None, existing) is False
