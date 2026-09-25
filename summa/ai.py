"""Claude-backed category suggestions for uncategorized invoices.

Wraps a single Anthropic request behind :func:`suggest_categories` so the route
layer stays thin and the logic is testable without a live API call. The request
uses structured output (a JSON schema), so the response is guaranteed-parseable.

Prompt-injection note: the request embeds user-controlled store and item names,
so a crafted name could try to steer the model. The blast radius is bounded — the
output schema permits only an (optional) ``invoice_id`` + ``category`` per entry,
and each returned category is length-capped and whitespace-normalized via
:func:`summa.helpers.clean_category` before it can be surfaced or persisted.
"""

import functools
import hashlib
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Final, Literal

import anthropic
from anthropic.types import (
    OutputConfigParam,
    ThinkingConfigAdaptiveParam,
    ThinkingConfigDisabledParam,
)

from summa.helpers import MAX_CATEGORY_LENGTH, clean_category

logger: logging.Logger = logging.getLogger(__name__)

API_KEY_ENV: Final[str] = "ANTHROPIC_API_KEY"
ENABLE_ENV: Final[str] = "ENABLE_AI_SUGGESTIONS"

# User-selectable models, keyed by the short identifier the client sends. The
# resolver below maps a key to its real model id, so an arbitrary client string
# never reaches the API.
MODELS: Final[dict[str, str]] = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-5",
    "opus": "claude-opus-4-8",
}
DEFAULT_MODEL_KEY: Final[str] = "haiku"

# Models supporting adaptive thinking + the effort parameter (4.6+). The default
# claude-haiku-4-5 is an older model that rejects both, so it runs with thinking
# disabled instead.
ADAPTIVE_MODELS: Final[frozenset[str]] = frozenset({MODELS["sonnet"], MODELS["opus"]})

# The output is one id + category per invoice, so it stays tiny; the budget is
# sized to the batch mostly to leave room for thinking tokens (which count
# against max_tokens) without truncating the JSON. The cap keeps the request
# under the SDK's ~10-minute non-streaming timeout guard, so no streaming needed.
_TOKEN_BUDGET_BASE: Final[int] = 4096
_TOKENS_PER_INVOICE: Final[int] = 64
_TOKEN_BUDGET_CAP: Final[int] = 15000

# The largest batch _max_tokens_for can fully fund before the cap clamps the
# per-invoice allowance. Callers cap their batch to this so a run never requests
# more tokens than the budget grants — which would truncate the response.
MAX_FULLY_BUDGETED_BATCH: Final[int] = (
    _TOKEN_BUDGET_CAP - _TOKEN_BUDGET_BASE
) // _TOKENS_PER_INVOICE  # (15000 - 4096) // 64 = 170

SYSTEM_PROMPT: Final[str] = (
    "You assign exactly one spending category to each invoice, based on its store "
    "name and purchased items. Prefer a category from the provided list of existing "
    "categories; only invent a new, concise category when none of them fit. Keep "
    "category names short and general (e.g. 'Groceries', 'Electronics', 'Finance')."
)

# Structured-output schema: an object wrapping the suggestion array. Every object
# sets `additionalProperties: false` so the model cannot drift onto extra keys.
# `invoice_id` is intentionally left out of the item `required` list: the model
# may omit it, and the parser below skips any entry without one — keeping the
# extraction decoupled from the schema. Only `category` is required per item.
OUTPUT_SCHEMA: Final[dict[str, Any]] = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "invoice_id": {"type": "integer"},
                    "category": {"type": "string", "maxLength": MAX_CATEGORY_LENGTH},
                },
                "required": ["category"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["suggestions"],
    "additionalProperties": False,
}


class AiCategorizationError(Exception):
    """Raised when the Claude request fails or returns an unusable response."""

    def __init__(self, message: str) -> None:
        """:param message: user-facing text, returned by the route as is."""
        super().__init__(message)
        # Read via `e.message`, never `str(e)`; see ValidationError in summa.helpers.
        self.message: str = message


@dataclass
class CategorySuggestion:
    """A single suggested category for one invoice.

    :param is_new: whether ``category`` is absent from the existing category list
        (computed server-side, case-insensitively, so it never depends on the model).
    """

    invoice_id: int
    category: str | None
    is_new: bool


def api_key_configured() -> bool:
    """Return whether an Anthropic API key is present in the environment."""
    return bool(os.environ.get(API_KEY_ENV))


def suggestions_enabled() -> bool:
    """Return whether AI suggestions are enabled via the master switch."""
    raw_value: str | None = os.environ.get(ENABLE_ENV)
    if raw_value is None:
        return False
    return raw_value.strip().lower() not in {"", "0", "false", "no", "off"}


def suggestions_available() -> bool:
    """Return whether AI suggestions are enabled and configured for use."""
    if not suggestions_enabled():
        return False
    return api_key_configured()


def resolve_model(key: str | None) -> str:
    """Map a user-selected model key to its real model id.

    :param key: the short key from the client (``haiku`` / ``sonnet`` / ``opus``).
    :returns: the model id, falling back to the default for unknown or missing keys.
    """
    return MODELS.get(key or DEFAULT_MODEL_KEY, MODELS[DEFAULT_MODEL_KEY])


def is_category_new(category: str | None, existing_lower: set[str]) -> bool:
    """Return whether ``category`` is absent from the existing categories.

    :param existing_lower: existing categories, already lower-cased. The check is
        case-insensitive so a suggestion differing only in casing is not flagged.
    """
    return category is not None and category.lower() not in existing_lower


def invoice_fingerprint(invoice: dict[str, Any]) -> str:
    """Return a stable hash over the invoice fields the model sees.

    Captures store, total and the (order-independent) line items, so any edit to
    them changes the fingerprint and invalidates a cached suggestion. Items are
    sorted first so a reordering alone does not count as a change.

    :param invoice: a dict with ``store``, ``total`` and an ``items`` list
        (``item_name`` / ``item_price``), as assembled by the route.
    """
    items: list[list[Any]] = sorted(
        [item["item_name"], item["item_price"]] for item in invoice["items"]
    )
    canonical: str = json.dumps(
        [invoice["store"], invoice["total"], items], sort_keys=True
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _max_tokens_for(invoice_count: int) -> int:
    """Size the output budget to the batch so thinking + JSON don't truncate."""
    budget: int = _TOKEN_BUDGET_BASE + invoice_count * _TOKENS_PER_INVOICE
    return min(_TOKEN_BUDGET_CAP, budget)


def _thinking_config(
    model: str,
) -> tuple[
    ThinkingConfigAdaptiveParam | ThinkingConfigDisabledParam, Literal["low"] | None
]:
    """Return the ``(thinking, effort)`` pair tuned to the model's capabilities.

    :param model: the resolved model id (see :func:`resolve_model`).
    :returns: the ``thinking`` request value and an optional ``effort`` level;
        adaptive models get low effort, others run with thinking disabled.
    """
    if model in ADAPTIVE_MODELS:
        return {"type": "adaptive"}, "low"
    return {"type": "disabled"}, None


@functools.cache
def _get_client() -> anthropic.Anthropic:
    """Return the lazily-constructed, reused Anthropic client.

    Built on first use (not at import) so the API key need only be present when a
    request is actually made, and reused across calls rather than rebuilt each time.
    """
    return anthropic.Anthropic()


def _extract_text(message: anthropic.types.Message) -> str:
    """Return the first text block of a response, or raise if none is present."""
    for block in message.content:
        if block.type == "text":
            return block.text
    raise AiCategorizationError("Claude response contained no text block")


def suggest_categories(
    invoices: list[dict[str, Any]], existing_categories: list[str], model: str
) -> list[CategorySuggestion]:
    """Ask Claude to categorize each invoice in a single structured request.

    :param invoices: dicts with ``id``, ``store`` and an ``items`` list
        (``item_name`` / ``item_price``), as assembled by the route.
    :param existing_categories: the categories already in use, given to the model
        as context and used to compute :attr:`CategorySuggestion.is_new`.
    :param model: the resolved model id (see :func:`resolve_model`).
    :raises AiCategorizationError: on any API error or an unparseable response.
    """
    if not invoices:
        return []

    client: anthropic.Anthropic = _get_client()
    user_payload: dict[str, Any] = {
        "existing_categories": existing_categories,
        "invoices": invoices,
    }

    thinking, effort = _thinking_config(model)
    output_config: OutputConfigParam = {
        "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}
    }
    if effort is not None:
        output_config["effort"] = effort

    try:
        message: anthropic.types.Message = client.messages.create(
            model=model,
            max_tokens=_max_tokens_for(len(invoices)),
            thinking=thinking,
            system=SYSTEM_PROMPT,
            output_config=output_config,
            messages=[{"role": "user", "content": json.dumps(user_payload)}],
        )
    except anthropic.APIError as error:
        logger.error("Claude categorization request failed: %s", error)
        raise AiCategorizationError("Claude request failed") from error

    # A truncated response would otherwise fail JSON parsing below with a
    # misleading "not valid JSON"; surface the real cause instead.
    if message.stop_reason == "max_tokens":
        raise AiCategorizationError(
            "Claude response was truncated (token budget exceeded) — "
            "try a smaller batch"
        )

    raw: str = _extract_text(message)
    try:
        parsed: Any = json.loads(raw)
    except json.JSONDecodeError as error:
        raise AiCategorizationError("Claude response was not valid JSON") from error

    existing_lower: set[str] = {category.lower() for category in existing_categories}

    suggestions: list[CategorySuggestion] = []
    for entry in parsed.get("suggestions", []):
        invoice_id: Any = entry.get("invoice_id")
        if invoice_id is None:
            continue
        category: str | None = clean_category(entry.get("category"))
        suggestions.append(
            CategorySuggestion(
                invoice_id=invoice_id,
                category=category,
                is_new=is_category_new(category, existing_lower),
            )
        )
    return suggestions
