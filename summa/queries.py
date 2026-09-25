"""SQL fragments shared by the invoice and stats blueprints."""

from collections.abc import Mapping
from typing import Final

from summa.helpers import escape_like

# (query arg, clause) pairs whose value binds straight to the placeholder.
_SIMPLE_FILTERS: Final[tuple[tuple[str, str], ...]] = (
    ("store", "store = ?"),
    ("category", "category = ?"),
    ("date_from", "date >= ?"),
    ("date_to", "date <= ?"),
)


def build_invoice_filter(args: Mapping[str, str]) -> tuple[str, list[str]]:
    """Build the WHERE clause and params for filtering active invoices.

    Kept separate from ORDER BY/LIMIT so the same clause and params can drive the
    list, count/sum, id-list and stats queries alike.

    :param args: the query args; ``search``, ``store``, ``category``,
        ``date_from`` and ``date_to`` are honoured, empty values are ignored.
    """
    where: str = "WHERE deleted_at IS NULL"
    params: list[str] = []

    search: str = args.get("search", "")
    if search:
        where += (
            " AND (store LIKE ? ESCAPE '\\' OR id IN "
            "(SELECT invoice_id FROM invoice_items WHERE item_name LIKE ? ESCAPE '\\'))"
        )
        escaped: str = escape_like(search)
        params.extend([f"%{escaped}%", f"%{escaped}%"])

    for arg, clause in _SIMPLE_FILTERS:
        value: str = args.get(arg, "")
        if value:
            where += f" AND {clause}"
            params.append(value)

    return where, params
