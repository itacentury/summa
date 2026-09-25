"""Tests for the statistics endpoint and its comparison helper."""

import pytest
from flask.testing import FlaskClient

from summa import db
from summa.routes.stats import _calculate_comparison
from tests.conftest import SeedInvoice, get_json

# --- GET /api/stats -----------------------------------------------------------


def test_stats_summary(client: FlaskClient, seed_invoice: SeedInvoice) -> None:
    """The summary reports invoice count, total and average."""
    seed_invoice(total=10.0)
    seed_invoice(total=30.0)

    summary = get_json(client.get("/api/stats"))["summary"]
    assert summary["total_invoices"] == 2
    assert summary["total_amount"] == 40.0
    assert summary["average_invoice"] == 20.0


def test_stats_empty_avoids_division_by_zero(client: FlaskClient) -> None:
    """With no invoices the average is 0 rather than a division error."""
    summary = get_json(client.get("/api/stats"))["summary"]
    assert summary["total_invoices"] == 0
    assert summary["total_amount"] == 0
    assert summary["average_invoice"] == 0


def test_stats_by_category_labels_null(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """NULL categories surface as 'Uncategorized', ordered by amount desc."""
    seed_invoice(category="Food", total=5.0)
    seed_invoice(category=None, total=20.0)

    by_category = get_json(client.get("/api/stats"))["by_category"]
    assert by_category[0] == {"category": "Uncategorized", "amount": 20.0, "count": 1}
    assert by_category[1] == {"category": "Food", "amount": 5.0, "count": 1}


def test_stats_by_store_ordered_by_amount(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Stores are ordered by descending spend."""
    seed_invoice(store="Small", total=5.0)
    seed_invoice(store="Big", total=50.0)

    by_store = get_json(client.get("/api/stats"))["by_store"]
    assert [entry["store"] for entry in by_store] == ["Big", "Small"]


def test_stats_excludes_soft_deleted(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Soft-deleted invoices are excluded from all aggregates."""
    seed_invoice(total=10.0)
    seed_invoice(total=999.0, deleted=True)

    summary = get_json(client.get("/api/stats"))["summary"]
    assert summary["total_invoices"] == 1
    assert summary["total_amount"] == 10.0


def test_stats_comparison_via_endpoint(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """The endpoint returns previous-period spend for a bounded date range."""
    # Current period: 2024-02-01..2024-02-29 (one invoice of 100).
    seed_invoice(date="2024-02-10", total=100.0)
    # Previous period of equal length ends 2024-01-31 (one invoice of 50).
    seed_invoice(date="2024-01-15", total=50.0)

    comparison = get_json(
        client.get("/api/stats?date_from=2024-02-01&date_to=2024-02-29")
    )["comparison"]
    assert comparison["previous_total"] == 50.0
    assert comparison["change_percent"] == 100.0


# --- _calculate_comparison ----------------------------------------------------


def test_comparison_returns_zero_without_dates(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """Missing either bound short-circuits to a zeroed comparison."""
    seed_invoice(total=10.0)
    conn = db.get_db()
    try:
        cursor = conn.cursor()
        assert _calculate_comparison(cursor, "", "2024-02-29", 10.0) == {
            "previous_total": 0,
            "change_percent": 0,
        }
    finally:
        conn.close()


def test_comparison_handles_invalid_dates(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """An unparseable date is caught and yields a zeroed comparison."""
    seed_invoice(total=10.0)
    conn = db.get_db()
    try:
        cursor = conn.cursor()
        result = _calculate_comparison(cursor, "not-a-date", "also-bad", 10.0)
    finally:
        conn.close()
    assert result == {"previous_total": 0, "change_percent": 0}


@pytest.mark.parametrize(
    ("date_from", "date_to"),
    [("20240201", "20240229"), ("2024-W05-4", "2024-W09-4")],
)
def test_comparison_rejects_non_canonical_iso_dates(
    client: FlaskClient, seed_invoice: SeedInvoice, date_from: str, date_to: str
) -> None:
    """Only YYYY-MM-DD is compared, matching the main query's string filter."""
    seed_invoice(date="2024-01-15", total=50.0)
    conn = db.get_db()
    try:
        cursor = conn.cursor()
        result = _calculate_comparison(cursor, date_from, date_to, 100.0)
    finally:
        conn.close()
    assert result == {"previous_total": 0, "change_percent": 0}


def test_comparison_zero_previous_keeps_percent_zero(
    client: FlaskClient, seed_invoice: SeedInvoice
) -> None:
    """With no previous-period spend the percent change stays 0 (no div-by-zero)."""
    seed_invoice(date="2024-02-10", total=100.0)
    conn = db.get_db()
    try:
        cursor = conn.cursor()
        result = _calculate_comparison(cursor, "2024-02-01", "2024-02-29", 100.0)
    finally:
        conn.close()
    assert result == {"previous_total": 0, "change_percent": 0}
