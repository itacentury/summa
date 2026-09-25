"""Unit tests for the shared SQL fragments in :mod:`summa.queries`."""

from summa.queries import build_invoice_filter


def test_no_args_only_excludes_deleted() -> None:
    """Without filters the clause only hides soft-deleted invoices."""
    assert build_invoice_filter({}) == ("WHERE deleted_at IS NULL", [])


def test_simple_filters_bind_in_order_and_skip_empty() -> None:
    """Each non-empty filter adds its clause and param; empty values are ignored."""
    where, params = build_invoice_filter(
        {"store": "Aldi", "category": "", "date_from": "2024-01-01", "date_to": ""}
    )
    assert where == "WHERE deleted_at IS NULL AND store = ? AND date >= ?"
    assert params == ["Aldi", "2024-01-01"]


def test_search_escapes_like_wildcards() -> None:
    """The search term matches store or item name literally."""
    where, params = build_invoice_filter({"search": "50%"})
    assert "store LIKE ?" in where
    assert params == ["%50\\%%", "%50\\%%"]
