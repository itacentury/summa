"""Shared types and helper functions for the Summa backend."""

import math
import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Final

from flask import Response, jsonify

# Type alias for API responses that may include HTTP status codes
ApiResponse = Response | tuple[Response, int]

# Cap the number of entries in a single /import batch (SECURITY-TODO M3): a small
# payload can still hold tens of thousands of rows, each a SELECT + INSERT.
MAX_IMPORT_BATCH: Final[int] = 10_000

# Categories are meant to be short and general; the cap also bounds the residual
# prompt-injection surface of the AI suggestion path (an injected store/item name
# cannot make an oversized category persist). See summa/ai.py.
MAX_CATEGORY_LENGTH: Final[int] = 64

# A year past 9999 is a valid HTML date-field value but unparseable by
# `date.fromisoformat`, so it would otherwise slip through the non-ISO tolerance
# branch of `_reject_future_date`. Such a date is by definition in the future.
# Only the significant digits decide: leading zeros are skipped, so "02026-…"
# stays in range while a padded overlong year ("010000-…") does not.
_OVERLONG_YEAR: Final[re.Pattern[str]] = re.compile(r"0*[1-9]\d{4,}-")


def error_response(message: str, status: int) -> tuple[Response, int]:
    """Build a standard {success: False, error: …} JSON error response."""
    return jsonify({"success": False, "error": message}), status


class ValidationError(Exception):
    """Raised when client-supplied invoice data is malformed."""

    def __init__(self, message: str, field: str | None = None) -> None:
        """:param field: the offending field name, if the error is field-specific."""
        super().__init__(message)
        # Expose the message as a plain attribute (read via `e.message`, never
        # `str(e)`): CodeQL py/stack-trace-exposure treats str(exception) flowing
        # into an HTTP response as tainted, and a plain attribute breaks that chain.
        self.message: str = message
        self.field: str | None = field


@dataclass
class InvoiceItem:
    """A single validated invoice line item."""

    item_name: str
    item_price: float


@dataclass
class Invoice:
    """A validated invoice parsed from a request payload."""

    date: str
    store: str
    category: str | None
    total: float
    items: list[InvoiceItem]


def strip_text(value: Any) -> str | None:
    """Strip whitespace from text values, returning None for empty strings."""
    if value is None:
        return None
    stripped: str = str(value).strip()
    return stripped if stripped else None


def require_optional_str(value: Any, field: str) -> str | None:
    """Return value if it is a string or None; raise ValidationError otherwise."""
    if value is not None and not isinstance(value, str):
        raise ValidationError(f"Field '{field}' must be a string", field=field)
    return value


def require_non_empty_str(value: Any, field: str) -> str:
    """Return a stripped non-empty string; raise ValidationError otherwise."""
    if not isinstance(value, str):
        raise ValidationError(f"Field '{field}' must be a string", field=field)
    stripped: str | None = strip_text(value)
    if stripped is None:
        raise ValidationError(f"Field '{field}' cannot be empty", field=field)
    return stripped


def clean_category(value: Any) -> str | None:
    """Normalize a category: collapse whitespace runs, cap length, empty -> None.

    Stricter than :func:`strip_text`: it also collapses interior whitespace
    (including newlines) and truncates to :data:`MAX_CATEGORY_LENGTH`.
    """
    if value is None:
        return None
    collapsed: str = " ".join(str(value).split())
    if not collapsed:
        return None
    # .strip() again in case truncation lands mid-space.
    return collapsed[:MAX_CATEGORY_LENGTH].strip() or None


def escape_like(value: str) -> str:
    """Escape LIKE wildcards so a search term matches literally."""
    # Escape the escape char first, then the two LIKE wildcards.
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def parse_bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    """Parse value to an int clamped to [minimum, maximum], falling back to default."""
    try:
        parsed: int = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))


def _require(data: dict[str, Any], key: str) -> Any:
    """Return data[key], raising ValidationError if the key is absent."""
    if key not in data:
        raise ValidationError(f"Missing required field: {key}", field=key)
    return data[key]


def parse_float(value: Any, field: str) -> float:
    """Convert value to a finite float, raising ValidationError otherwise."""
    try:
        parsed: float = float(value)
    except (TypeError, ValueError):
        raise ValidationError(
            f"Field '{field}' must be a number", field=field
        ) from None
    # JSON's Infinity/NaN literals parse fine but cannot be serialised back, so a
    # stored one breaks every later GET.
    if not math.isfinite(parsed):
        raise ValidationError(f"Field '{field}' must be a finite number", field=field)
    return parsed


def _reject_future_date(date_value: str) -> None:
    """Reject invoice dates in the future — the app has no future invoices."""
    if _OVERLONG_YEAR.match(date_value):
        raise ValidationError("Invoice date cannot be in the future", field="date")
    try:
        parsed: date = date.fromisoformat(date_value[:10])
    except ValueError:
        # Keep the parser's existing tolerance for non-ISO date strings; the
        # future guard only applies to recognizable ISO dates.
        return
    # `date.today()` resolves in the server's timezone. A client ahead of the
    # server (e.g. UTC+10 near local midnight) may briefly have a local "today"
    # that the server still sees as tomorrow, yielding a false rejection. This
    # is an accepted trade-off for same-zone self-hosted deployments; we keep
    # the rule strict rather than granting a grace day.
    if parsed > date.today():
        raise ValidationError("Invoice date cannot be in the future", field="date")


def parse_invoice(data: Any) -> Invoice:
    """Validate and parse a single invoice payload into an Invoice."""
    if not isinstance(data, dict):
        raise ValidationError("Invoice must be a JSON object")

    invoice_date: str = require_non_empty_str(_require(data, "date"), "date")
    _reject_future_date(invoice_date)

    store: str = require_non_empty_str(_require(data, "store"), "store")
    category: str | None = clean_category(
        require_optional_str(data.get("category"), "category")
    )
    total: float = parse_float(_require(data, "total"), "total")

    items: list[InvoiceItem] = []
    raw_items: Any = data.get("items", [])
    if not isinstance(raw_items, list):
        raise ValidationError("Field 'items' must be a list", field="items")
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            raise ValidationError("Each item must be a JSON object")
        name: str = require_non_empty_str(_require(raw_item, "item_name"), "item_name")
        price: float = parse_float(_require(raw_item, "item_price"), "item_price")
        items.append(InvoiceItem(item_name=name, item_price=price))

    if not items:
        raise ValidationError("Invoice must contain at least one item", field="items")

    return Invoice(
        date=invoice_date,
        store=store,
        category=category,
        total=total,
        items=items,
    )


def parse_id_list(data: Any) -> list[int]:
    """Validate a bulk payload and return its non-empty list of integer ids."""
    if not isinstance(data, dict):
        raise ValidationError("Request body must be a JSON object")
    ids: Any = data.get("ids")
    if not isinstance(ids, list) or not ids:
        raise ValidationError("Field 'ids' must be a non-empty list", field="ids")
    for id_value in ids:
        # bool is a subclass of int; reject it explicitly so `true` is not `1`.
        if not isinstance(id_value, int) or isinstance(id_value, bool):
            raise ValidationError("Field 'ids' must contain only integers", field="ids")
    return ids


@dataclass
class ImportEntryError:
    """One invalid entry from a batch import: its position, field and reason."""

    index: int
    field: str | None
    message: str
    value: Any  # the raw entry, so the client can prefill an editor


@dataclass
class ImportValidation:
    """The outcome of validating a batch: the valid invoices plus per-entry errors."""

    invoices: list[Invoice]
    errors: list[ImportEntryError]


def parse_invoice_batch(data: Any) -> ImportValidation:
    """Validate a list of invoice payloads, collecting per-entry errors (for /import).

    Unlike :func:`parse_invoice`, a single malformed entry does not abort the batch:
    valid entries are still parsed and each failure is recorded with its array index.
    """
    if not isinstance(data, list):
        raise ValidationError("Expected a list of invoices")

    if len(data) > MAX_IMPORT_BATCH:
        raise ValidationError(
            f"Import batch too large (max {MAX_IMPORT_BATCH} invoices)"
        )

    invoices: list[Invoice] = []
    errors: list[ImportEntryError] = []
    for index, item in enumerate(data):
        try:
            invoices.append(parse_invoice(item))
        except ValidationError as error:
            errors.append(ImportEntryError(index, error.field, error.message, item))
    return ImportValidation(invoices=invoices, errors=errors)
