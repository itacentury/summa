"""Unit tests for the pure helper functions in :mod:`summa.helpers`."""

from datetime import date, timedelta
from typing import Any

import pytest

from summa.helpers import (
    MAX_CATEGORY_LENGTH,
    ValidationError,
    escape_like,
    parse_id_list,
    parse_invoice,
    parse_invoice_batch,
    strip_text,
)


def _valid_items() -> list[dict[str, Any]]:
    """Return a minimal valid items list for invoice parsing tests."""
    return [{"item_name": "Item", "item_price": 1.0}]


def test_parse_invoice_cleans_category() -> None:
    """parse_invoice collapses inner whitespace and caps the category length."""
    invoice = parse_invoice(
        {
            "date": "2024-01-01",
            "store": "A",
            "category": "  Food\n\n  Stuff " + "x" * 200,
            "total": 1.0,
            "items": _valid_items(),
        }
    )
    assert invoice.category is not None
    assert invoice.category.startswith("Food Stuff")
    assert len(invoice.category) <= MAX_CATEGORY_LENGTH


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        ("  hello  ", "hello"),
        ("hello", "hello"),
        ("", None),
        ("   ", None),
        ("\t\n", None),
        (5, "5"),
        (0, "0"),
        (3.5, "3.5"),
    ],
)
def test_strip_text(value: Any, expected: str | None) -> None:
    """strip_text normalizes whitespace and maps empty input to None."""
    assert strip_text(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("ab", "ab"),
        ("a_b", "a\\_b"),
        ("50%", "50\\%"),
        ("a\\b", "a\\\\b"),
    ],
)
def test_escape_like(value: str, expected: str) -> None:
    """escape_like backslash-escapes LIKE wildcards and the escape char."""
    assert escape_like(value) == expected


def test_parse_invoice_batch_all_valid() -> None:
    """A fully valid batch parses every entry and reports no errors."""
    result = parse_invoice_batch(
        [
            {
                "date": "2024-01-01",
                "store": "A",
                "total": 1.0,
                "items": _valid_items(),
            },
            {
                "date": "2024-01-02",
                "store": "B",
                "total": 2.0,
                "items": _valid_items(),
            },
        ]
    )
    assert [invoice.store for invoice in result.invoices] == ["A", "B"]
    assert result.errors == []


def test_parse_invoice_batch_collects_errors_with_index_and_field() -> None:
    """Invalid entries are collected with their array index, field and raw value."""
    raw_bad = {"date": "2024-01-01", "store": "Bad", "total": "abc"}
    result = parse_invoice_batch(
        [
            {
                "date": "2024-01-01",
                "store": "Good",
                "total": 1.0,
                "items": _valid_items(),
            },
            {"store": "NoDate", "total": 1.0},
            raw_bad,
        ]
    )
    assert [invoice.store for invoice in result.invoices] == ["Good"]
    assert [(error.index, error.field) for error in result.errors] == [
        (1, "date"),
        (2, "total"),
    ]
    assert result.errors[1].message == "Field 'total' must be a number"
    assert result.errors[1].value == raw_bad


def test_parse_invoice_non_list_items_raises() -> None:
    """A truthy non-list `items` raises ValidationError instead of a bare TypeError."""
    with pytest.raises(ValidationError, match="Field 'items' must be a list") as info:
        parse_invoice({"date": "2024-01-01", "store": "A", "total": 1.0, "items": 5})
    assert info.value.field == "items"


def test_parse_invoice_rejects_future_date() -> None:
    """A date after today raises ValidationError flagged on the date field."""
    tomorrow: str = (date.today() + timedelta(days=1)).isoformat()
    with pytest.raises(
        ValidationError, match="Invoice date cannot be in the future"
    ) as info:
        parse_invoice(
            {"date": tomorrow, "store": "A", "total": 1.0, "items": _valid_items()}
        )
    assert info.value.field == "date"


@pytest.mark.parametrize("day", ["10000-01-01", "275760-09-13", "010000-01-01"])
def test_parse_invoice_rejects_year_past_9999(day: str) -> None:
    """A 5+ significant-digit year is future, even zero-padded."""
    with pytest.raises(
        ValidationError, match="Invoice date cannot be in the future"
    ) as info:
        parse_invoice(
            {"date": day, "store": "A", "total": 1.0, "items": _valid_items()}
        )
    assert info.value.field == "date"


def test_parse_invoice_tolerates_zero_padded_year() -> None:
    """A zero-padded year is not past 9999 — it keeps the non-ISO tolerance."""
    invoice = parse_invoice(
        {"date": "02026-01-01", "store": "A", "total": 1.0, "items": _valid_items()}
    )
    assert invoice.date == "02026-01-01"


@pytest.mark.parametrize("offset", [0, -1, -365])
def test_parse_invoice_accepts_today_and_past_dates(offset: int) -> None:
    """Today and any past date parse without error (no future bound violated)."""
    day: str = (date.today() + timedelta(days=offset)).isoformat()
    assert (
        parse_invoice(
            {"date": day, "store": "A", "total": 1.0, "items": _valid_items()}
        ).date
        == day
    )


def test_parse_invoice_tolerates_non_iso_date() -> None:
    """A non-ISO date string keeps the parser's existing tolerance (no future guard)."""
    invoice = parse_invoice(
        {"date": "not-a-date", "store": "A", "total": 1.0, "items": _valid_items()}
    )
    assert invoice.date == "not-a-date"


def test_parse_invoice_rejects_empty_items() -> None:
    """An invoice without line items is rejected on the items field."""
    with pytest.raises(
        ValidationError, match="Invoice must contain at least one item"
    ) as info:
        parse_invoice({"date": "2024-01-01", "store": "A", "total": 1.0, "items": []})
    assert info.value.field == "items"


def test_parse_invoice_batch_collects_future_date_error() -> None:
    """A future-dated entry is collected per-entry; sibling valid entries still parse."""
    tomorrow: str = (date.today() + timedelta(days=1)).isoformat()
    result = parse_invoice_batch(
        [
            {
                "date": "2024-01-01",
                "store": "Good",
                "total": 1.0,
                "items": _valid_items(),
            },
            {
                "date": tomorrow,
                "store": "Future",
                "total": 2.0,
                "items": _valid_items(),
            },
        ]
    )
    assert [invoice.store for invoice in result.invoices] == ["Good"]
    assert [(error.index, error.field) for error in result.errors] == [(1, "date")]


def test_parse_invoice_batch_non_list_items_does_not_abort_batch() -> None:
    """A bad `items` field is collected per-entry; sibling valid entries still parse."""
    result = parse_invoice_batch(
        [
            {
                "date": "2024-01-01",
                "store": "Good",
                "total": 1.0,
                "items": _valid_items(),
            },
            {"date": "2024-01-02", "store": "Bad", "total": 2.0, "items": 5},
        ]
    )
    assert [invoice.store for invoice in result.invoices] == ["Good"]
    assert [(error.index, error.field) for error in result.errors] == [(1, "items")]


def test_parse_invoice_batch_collects_empty_items_error() -> None:
    """An entry with empty items is reported while valid siblings still parse."""
    result = parse_invoice_batch(
        [
            {
                "date": "2024-01-01",
                "store": "Good",
                "total": 1.0,
                "items": _valid_items(),
            },
            {"date": "2024-01-02", "store": "Bad", "total": 2.0, "items": []},
        ]
    )
    assert [invoice.store for invoice in result.invoices] == ["Good"]
    assert [(error.index, error.field) for error in result.errors] == [(1, "items")]


def test_parse_invoice_batch_non_list_raises() -> None:
    """A non-list payload raises, so the endpoint can answer 400."""
    with pytest.raises(ValidationError, match="Expected a list of invoices"):
        parse_invoice_batch({"date": "2024-01-01"})


def test_parse_id_list_valid() -> None:
    """A dict with a non-empty list of ints returns that list unchanged."""
    assert parse_id_list({"ids": [1, 2, 3]}) == [1, 2, 3]


@pytest.mark.parametrize(
    ("data", "match"),
    [
        ([1, 2], "Request body must be a JSON object"),
        ("nope", "Request body must be a JSON object"),
        ({}, "Field 'ids' must be a non-empty list"),
        ({"ids": []}, "Field 'ids' must be a non-empty list"),
        ({"ids": "abc"}, "Field 'ids' must be a non-empty list"),
        ({"ids": [1, "x"]}, "Field 'ids' must contain only integers"),
        ({"ids": [True]}, "Field 'ids' must contain only integers"),
    ],
)
def test_parse_id_list_rejects_malformed(data: Any, match: str) -> None:
    """Non-dict bodies and non-int-list `ids` raise ValidationError, not TypeError."""
    with pytest.raises(ValidationError, match=match):
        parse_id_list(data)


def test_validation_error_exposes_field() -> None:
    """ValidationError carries the offending field for machine-readable reporting."""
    assert ValidationError("bad", field="total").field == "total"
    assert ValidationError("generic").field is None
