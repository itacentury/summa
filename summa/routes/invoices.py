"""REST API routes for invoice CRUD, bulk operations, stores and categories."""

import logging
import sqlite3
from dataclasses import asdict
from typing import Any, Final

from flask import Blueprint, Response, jsonify, request

from summa.ai import (
    MAX_FULLY_BUDGETED_BATCH,
    AiCategorizationError,
    CategorySuggestion,
    invoice_fingerprint,
    is_category_new,
    resolve_model,
    suggest_categories,
    suggestions_available,
)
from summa.db import (
    chunked,
    db_cursor,
    insert_invoice,
    insert_invoice_items,
    placeholders_for,
)
from summa.helpers import (
    ApiResponse,
    ImportValidation,
    Invoice,
    ValidationError,
    clean_category,
    error_response,
    parse_bounded_int,
    parse_id_list,
    parse_invoice,
    parse_invoice_batch,
    require_optional_str,
    strip_text,
)
from summa.queries import build_invoice_filter

logger: logging.Logger = logging.getLogger(__name__)

invoices_bp: Blueprint = Blueprint("invoices", __name__)

DEFAULT_PAGE_SIZE: Final[int] = 25
MAX_PAGE_SIZE: Final[int] = 200
ALL_PAGE_SIZE_TOKEN: Final[str] = "all"
# The only guard between the client's sort_by and the ORDER BY f-string.
SORT_COLUMNS: Final[frozenset[str]] = frozenset({"date", "store", "total"})
# Cap per categorize-suggest run to bound Claude token use and cost. The AI
# layer's fully-budgeted batch is the term that binds today (170 < 200), keeping a
# run inside the token budget so the response is never truncated; MAX_PAGE_SIZE is
# the second term only so a future budget increase cannot push the cap past one
# page. The response `total` lets the client prompt a re-run when a larger view is
# capped.
CATEGORIZE_SUGGEST_LIMIT: Final[int] = min(MAX_PAGE_SIZE, MAX_FULLY_BUDGETED_BATCH)
# How many ids a bulk log line names; select-all can post thousands.
LOG_ID_SAMPLE: Final[int] = 5


def _invoice_summary(row: sqlite3.Row) -> dict[str, Any]:
    """Serialize an invoice row without its line items."""
    return {
        "id": row["id"],
        "date": row["date"],
        "store": row["store"],
        "category": row["category"],
        "total": row["total"],
    }


def _existing_categories(cursor: sqlite3.Cursor) -> list[str]:
    """Return every category in use on an active invoice, sorted."""
    cursor.execute(
        "SELECT DISTINCT category FROM invoices "
        "WHERE deleted_at IS NULL AND category IS NOT NULL ORDER BY category"
    )
    return [row["category"] for row in cursor.fetchall()]


@invoices_bp.route("/api/invoices", methods=["GET"])
def get_invoices() -> Response:
    """Retrieve a page of invoices with optional filtering and sorting.

    ``uncategorized_count`` is scoped to the active filters rather than to the
    returned page, so the client can say how many uncategorized invoices the other
    pages still hold -- the page's own share is countable from ``invoices``.
    """
    where, params = build_invoice_filter(request.args)

    # Sorting. Always include `id` as a unique tie-breaker so rows sharing a
    # sort value keep a stable relative order across LIMIT/OFFSET page
    # boundaries (otherwise paging can skip or duplicate rows).
    sort_by: str = request.args.get("sort_by", "date")
    if sort_by in SORT_COLUMNS:
        direction: str = (
            "DESC" if request.args.get("sort_order", "desc") == "desc" else "ASC"
        )
        order: str = f" ORDER BY {sort_by} {direction}, id DESC"
    else:
        order = " ORDER BY id DESC"

    # Pagination. "all" is an explicit request for every matching row on a single
    # page; numeric page sizes are clamped to MAX_PAGE_SIZE.
    fetch_all: bool = request.args.get("page_size") == ALL_PAGE_SIZE_TOKEN
    page: int = parse_bounded_int(request.args.get("page"), 1, 1, 1_000_000)
    page_size: int = parse_bounded_int(
        request.args.get("page_size"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE
    )
    if fetch_all:
        page = 1

    with db_cursor() as cursor:
        # The uncategorized tally rides along in the totals query rather than costing a
        # second round trip. COALESCE because SUM over zero rows is NULL, and
        # `category IS NULL` is the predicate /categorize-suggest scopes by, so the
        # two endpoints can never disagree on what "uncategorized" means.
        cursor.execute(
            f"SELECT COUNT(*) AS total_count, COALESCE(SUM(total), 0) AS total_sum, "
            f"COALESCE(SUM(CASE WHEN category IS NULL THEN 1 ELSE 0 END), 0) "
            f"AS uncategorized_count "
            f"FROM invoices {where}",
            params,
        )
        totals: sqlite3.Row = cursor.fetchone()
        total_count: int = totals["total_count"]
        total_sum: float = totals["total_sum"]
        uncategorized_count: int = totals["uncategorized_count"]

        if fetch_all:
            # Report the served size so the client's ceil(total/size) collapses to
            # one page. max(..., 1) avoids a zero page_size on an empty result set.
            page_size = max(total_count, 1)
            cursor.execute(f"SELECT * FROM invoices {where}{order}", params)
        else:
            offset: int = (page - 1) * page_size
            cursor.execute(
                f"SELECT * FROM invoices {where}{order} LIMIT ? OFFSET ?",
                [*params, page_size, offset],
            )
        invoices: list[sqlite3.Row] = cursor.fetchall()

    # The list is intentionally compact: line items are loaded on demand via
    # the single-invoice detail endpoint (on first expand / edit), not here.
    result: list[dict[str, Any]] = [_invoice_summary(invoice) for invoice in invoices]
    return jsonify(
        {
            "invoices": result,
            "page": page,
            "page_size": page_size,
            "total_count": total_count,
            "total_sum": total_sum,
            "uncategorized_count": uncategorized_count,
        }
    )


@invoices_bp.route("/api/invoices/ids", methods=["GET"])
def get_invoice_ids() -> Response:
    """Return the ids of every invoice matching the current filters.

    Backs cross-page "select all": the client needs the full filtered id set,
    which the paginated list endpoint does not expose. Reuses the same filter
    clause so both endpoints always agree on what "matching" means.
    """
    where, params = build_invoice_filter(request.args)
    with db_cursor() as cursor:
        cursor.execute(f"SELECT id FROM invoices {where} ORDER BY id", params)
        ids: list[int] = [row["id"] for row in cursor.fetchall()]
    return jsonify({"ids": ids})


@invoices_bp.route("/api/invoices/<int:invoice_id>", methods=["GET"])
def get_invoice(invoice_id: int) -> ApiResponse:
    """Return a single invoice with its line items.

    Backs the compact list: line items are omitted from `GET /api/invoices` and
    loaded here on demand (first expand of a row, or opening the edit dialog).
    Honours the soft-delete convention — deleted invoices are treated as absent.
    """
    with db_cursor() as cursor:
        cursor.execute(
            "SELECT * FROM invoices WHERE id = ? AND deleted_at IS NULL",
            (invoice_id,),
        )
        invoice: sqlite3.Row | None = cursor.fetchone()
        if invoice is None:
            return error_response("Invoice not found", 404)

        cursor.execute(
            "SELECT item_name, item_price FROM invoice_items WHERE invoice_id = ?",
            (invoice_id,),
        )
        items: list[dict[str, Any]] = [
            {"item_name": item["item_name"], "item_price": item["item_price"]}
            for item in cursor.fetchall()
        ]

    return jsonify({**_invoice_summary(invoice), "items": items})


@invoices_bp.route("/api/stores", methods=["GET"])
def get_stores() -> Response:
    """Return a list of all unique store names."""
    with db_cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT store FROM invoices WHERE deleted_at IS NULL ORDER BY store"
        )
        stores: list[str] = [row["store"] for row in cursor.fetchall()]
    return jsonify(stores)


@invoices_bp.route("/api/categories", methods=["GET"])
def get_categories() -> Response:
    """Return a list of all unique invoice categories."""
    with db_cursor() as cursor:
        categories: list[str] = _existing_categories(cursor)
    return jsonify(categories)


def _cache_suggestions(
    results: list[CategorySuggestion],
    model: str,
    fingerprint_by_id: dict[int, str],
    resolved_category: dict[int, str | None],
) -> None:
    """Persist fresh model answers and merge them into ``resolved_category``.

    Best-effort: a cache write failure is logged, not raised — the suggestions
    are still valid and will simply be recomputed next time. Results for ids that
    were not sent (no known fingerprint) are skipped defensively.

    :param fingerprint_by_id: fingerprint per sent invoice id.
    :param resolved_category: mutated in place with each result's category.
    """
    upserts: list[tuple[int, str | None, str, str]] = []
    for result in results:
        fingerprint: str | None = fingerprint_by_id.get(result.invoice_id)
        if fingerprint is None:
            continue
        resolved_category[result.invoice_id] = result.category
        upserts.append((result.invoice_id, result.category, model, fingerprint))

    if not upserts:
        return
    try:
        with db_cursor() as cursor:
            cursor.executemany(
                "INSERT INTO invoice_category_suggestions "
                "(invoice_id, category, model, fingerprint) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(invoice_id) DO UPDATE SET "
                "category = excluded.category, model = excluded.model, "
                "fingerprint = excluded.fingerprint, created_at = CURRENT_TIMESTAMP",
                upserts,
            )
    except sqlite3.Error as error:
        logger.warning("Failed to cache category suggestions: %s", error)


@invoices_bp.route("/api/invoices/categorize-suggest", methods=["POST"])
def categorize_suggest() -> ApiResponse:
    """Suggest categories for the invoices visible on the caller's current page.

    Read-only: the client sends the ids of the invoices currently shown (POST body
    ``{"ids": [...]}``); this collects the uncategorized ones among them (with
    items), asks Claude for one category each, and returns the suggestions for
    review. Scoping by explicit ids keeps the analysis limited to exactly the
    rows on the current page rather than the whole filtered set. The actual
    write goes through the existing ``/api/invoices/bulk-update`` path once the
    user confirms.

    A body-less POST and ``{"ids": []}`` both mean "empty page" and return an empty
    result; any other body must carry a valid ``ids`` or it is a 400.
    """
    if not suggestions_available():
        return error_response("AI categorization not configured", 503)

    # An absent body is a legitimately empty page: 200, no work. A body that *is*
    # present must carry a valid `ids` (an empty list included), so a typo'd key or
    # malformed JSON is a 400 rather than a silent empty success -- the raw body is
    # what tells the two apart, since get_json(silent=True) returns None for both.
    # Everything past the empty case goes through parse_id_list, as /bulk-* do.
    if not request.get_data():
        return jsonify({"suggestions": [], "count": 0, "total": 0})
    data: Any = request.get_json(silent=True)
    if isinstance(data, dict) and data.get("ids") == []:
        return jsonify({"suggestions": [], "count": 0, "total": 0})
    try:
        # Dedupe once: IN dedupes within a chunk, but the same id split across two
        # chunks would double-count the summed total (and duplicate work).
        requested_ids: list[int] = list(dict.fromkeys(parse_id_list(data)))
    except ValidationError as error:
        return error_response(error.message, 400)

    # Scope strictly to the requested (visible) rows, uncategorized only. The id
    # list is client-supplied and unbounded (page_size=all posts the whole table),
    # so query in chunks below SQLite's variable limit rather than binding every id
    # in one statement, exactly as /bulk-update and /bulk-delete do.
    with db_cursor() as cursor:
        total: int = 0
        # Each chunk yields its own lowest-id candidates; the global lowest
        # CATEGORIZE_SUGGEST_LIMIT are guaranteed among them, so a Python
        # sort + slice reproduces a single ORDER BY id LIMIT over all ids.
        candidates: list[sqlite3.Row] = []
        for chunk in chunked(requested_ids):
            uncategorized_in_chunk: str = (
                f"FROM invoices WHERE deleted_at IS NULL AND category IS NULL "
                f"AND id IN ({placeholders_for(len(chunk))})"
            )
            cursor.execute(f"SELECT COUNT(*) AS total {uncategorized_in_chunk}", chunk)
            total += cursor.fetchone()["total"]
            cursor.execute(
                f"SELECT id, store, total {uncategorized_in_chunk} ORDER BY id LIMIT ?",
                [*chunk, CATEGORIZE_SUGGEST_LIMIT],
            )
            candidates.extend(cursor.fetchall())
        candidates.sort(key=lambda row: row["id"])
        rows: list[sqlite3.Row] = candidates[:CATEGORIZE_SUGGEST_LIMIT]

        # Full per-invoice info for the response (store, amount, items); the
        # items double as the model input and the client's summary/accordion.
        # Load every row's items in one query (ids are already capped at
        # CATEGORIZE_SUGGEST_LIMIT, well under SQLite's variable limit) and
        # group them in Python, avoiding a per-invoice round-trip.
        invoices: list[dict[str, Any]] = []
        if rows:
            ids: list[int] = [row["id"] for row in rows]
            cursor.execute(
                f"SELECT invoice_id, item_name, item_price FROM invoice_items "
                f"WHERE invoice_id IN ({placeholders_for(len(ids))})",
                ids,
            )
            items_by_invoice: dict[int, list[dict[str, Any]]] = {}
            for item in cursor.fetchall():
                items_by_invoice.setdefault(item["invoice_id"], []).append(
                    {
                        "item_name": item["item_name"],
                        "item_price": item["item_price"],
                    }
                )
            for row in rows:
                invoices.append(
                    {
                        "id": row["id"],
                        "store": row["store"],
                        "total": row["total"],
                        "items": items_by_invoice.get(row["id"], []),
                    }
                )

        existing_categories: list[str] = _existing_categories(cursor)

        # Previously cached suggestions for exactly these invoices, so only
        # new/edited ones (or a model change) need a fresh Claude call below.
        cached_rows: list[sqlite3.Row] = []
        if rows:
            cursor.execute(
                f"SELECT invoice_id, category, model, fingerprint "
                f"FROM invoice_category_suggestions "
                f"WHERE invoice_id IN ({placeholders_for(len(ids))})",
                ids,
            )
            cached_rows = cursor.fetchall()

    if not invoices:
        return jsonify({"suggestions": [], "count": 0, "total": 0})

    model_key: Any = data.get("model")
    model: str = resolve_model(model_key if isinstance(model_key, str) else None)
    cache_by_id: dict[int, sqlite3.Row] = {
        row["invoice_id"]: row for row in cached_rows
    }
    fingerprint_by_id: dict[int, str] = {
        invoice["id"]: invoice_fingerprint(invoice) for invoice in invoices
    }

    # Reuse a cached suggestion when the invoice content and model both match;
    # everything else (new, edited, or a model switch) goes to Claude.
    resolved_category: dict[int, str | None] = {}
    misses: list[dict[str, Any]] = []
    for invoice in invoices:
        cached: sqlite3.Row | None = cache_by_id.get(invoice["id"])
        matches: bool = (
            cached is not None
            and cached["fingerprint"] == fingerprint_by_id[invoice["id"]]
            and cached["model"] == model
        )
        if matches and cached is not None:
            resolved_category[invoice["id"]] = cached["category"]
        else:
            misses.append(invoice)

    if misses:
        try:
            results = suggest_categories(misses, existing_categories, model=model)
        except AiCategorizationError as error:
            logger.error("AI categorization failed: %s", error.message)
            return error_response(error.message, 502)
        _cache_suggestions(results, model, fingerprint_by_id, resolved_category)

    # Merge each suggestion with the invoice's display info (store, amount, items),
    # in the stable id order the invoices were loaded. is_new is recomputed live
    # (not cached) because it depends on the current category set, not the invoice.
    existing_lower: set[str] = {category.lower() for category in existing_categories}
    suggestions: list[dict[str, Any]] = []
    for invoice in invoices:
        if invoice["id"] not in resolved_category:
            # The model returned no entry for this invoice — omit it, as before.
            continue
        category: str | None = resolved_category[invoice["id"]]
        suggestions.append(
            {
                "invoice_id": invoice["id"],
                "store": invoice["store"],
                "total": invoice["total"],
                "items": invoice["items"],
                "category": category,
                "is_new": is_category_new(category, existing_lower),
            }
        )

    logger.info(
        "Categorization suggested: %d of %d uncategorized invoices (%d reused)",
        len(suggestions),
        total,
        len(invoices) - len(misses),
    )
    return jsonify(
        {
            "suggestions": suggestions,
            "count": len(suggestions),
            "total": total,
        }
    )


@invoices_bp.route("/api/invoices", methods=["POST"])
def add_invoice() -> ApiResponse:
    """Create a new invoice with its associated items."""
    data: Any = request.json
    try:
        invoice: Invoice = parse_invoice(data)
    except ValidationError as e:
        return error_response(e.message, 400)

    with db_cursor() as cursor:
        invoice_id: int | None = insert_invoice(cursor, invoice)
    logger.info(
        "Invoice created: id=%s, store='%s', total=%.2f, items=%d",
        invoice_id,
        invoice.store,
        invoice.total,
        len(invoice.items),
    )
    return jsonify({"success": True, "id": invoice_id})


@invoices_bp.route("/api/invoices/import", methods=["POST"])
def import_invoices() -> ApiResponse:
    """Bulk import invoices with partial success: valid entries are imported even
    when others are invalid, and per-entry validation errors are returned instead
    of aborting the whole batch. Duplicates (same date+store+total) are skipped.
    """
    data: Any = request.json
    try:
        validation: ImportValidation = parse_invoice_batch(data)
    except ValidationError as e:
        # Only a wholly wrong payload type (not a list) aborts with 400.
        return error_response(e.message, 400)

    imported_count: int = 0
    skipped_count: int = 0

    with db_cursor() as cursor:
        for invoice in validation.invoices:
            # Duplicate check: same combination of date, store and total amount
            cursor.execute(
                "SELECT id FROM invoices "
                "WHERE date = ? AND store = ? AND total = ? AND deleted_at IS NULL",
                (invoice.date, invoice.store, invoice.total),
            )
            existing: Any = cursor.fetchone()

            if existing:
                skipped_count += 1
                continue

            insert_invoice(cursor, invoice)
            imported_count += 1

    logger.info(
        "Import completed: imported=%d, skipped=%d, failed=%d (of %d total)",
        imported_count,
        skipped_count,
        len(validation.errors),
        len(validation.invoices) + len(validation.errors),
    )
    return jsonify(
        {
            "success": True,
            "imported": imported_count,
            "skipped": skipped_count,
            "failed": len(validation.errors),
            "errors": [asdict(error) for error in validation.errors],
        }
    )


@invoices_bp.route("/api/invoices/<int:invoice_id>", methods=["PUT"])
def update_invoice(invoice_id: int) -> ApiResponse:
    """Update an existing invoice and replace all its items."""
    data: Any = request.json
    try:
        invoice: Invoice = parse_invoice(data)
    except ValidationError as e:
        return error_response(e.message, 400)

    with db_cursor() as cursor:
        cursor.execute(
            "UPDATE invoices SET date = ?, store = ?, category = ?, total = ? "
            "WHERE id = ? AND deleted_at IS NULL",
            (
                invoice.date,
                invoice.store,
                invoice.category,
                invoice.total,
                invoice_id,
            ),
        )
        # A soft-deleted or unknown invoice is treated as absent: bail out
        # before touching its items instead of silently rewriting them.
        if cursor.rowcount == 0:
            return error_response("Invoice not found", 404)
        # Replace all items: remove the old ones, then insert the new set
        cursor.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (invoice_id,))
        insert_invoice_items(cursor, invoice_id, invoice.items)
    logger.info(
        "Invoice updated: id=%d, store='%s', total=%.2f, items=%d",
        invoice_id,
        invoice.store,
        invoice.total,
        len(invoice.items),
    )
    return jsonify({"success": True})


@invoices_bp.route("/api/invoices/<int:invoice_id>", methods=["DELETE"])
def delete_invoice(invoice_id: int) -> ApiResponse:
    """Soft-delete an invoice by setting its deleted_at timestamp."""
    with db_cursor() as cursor:
        # Soft delete: set deleted_at timestamp instead of removing from database
        cursor.execute(
            "UPDATE invoices SET deleted_at = CURRENT_TIMESTAMP "
            "WHERE id = ? AND deleted_at IS NULL",
            (invoice_id,),
        )
        if cursor.rowcount == 0:
            return error_response("Invoice not found", 404)
    logger.info("Invoice soft-deleted: id=%d", invoice_id)
    return jsonify({"success": True})


@invoices_bp.route("/api/invoices/bulk-update", methods=["PUT"])
def bulk_update_invoices() -> ApiResponse:
    """Update store name and/or category for multiple invoices at once."""
    data: Any = request.json
    try:
        invoice_ids: list[int] = parse_id_list(data)
        new_store: str | None = strip_text(
            require_optional_str(data.get("store"), "store")
        )
        # Keep the raw string (empty string is meaningful below); type-check only.
        new_category: str | None = require_optional_str(
            data.get("category"), "category"
        )
    except ValidationError as e:
        return error_response(e.message, 400)

    if not new_store and new_category is None:
        return error_response("Missing store or category", 400)

    set_clauses: list[str] = []
    params: list[str | int | None] = []

    if new_store:
        set_clauses.append("store = ?")
        params.append(new_store)

    if new_category is not None:
        set_clauses.append("category = ?")
        # Empty string means remove category (set to NULL); clean_category also
        # length-caps so no client can persist an oversized category.
        params.append(clean_category(new_category))

    set_clause: str = ", ".join(set_clauses)
    with db_cursor() as cursor:
        updated_count: int = 0
        for chunk in chunked(invoice_ids):
            cursor.execute(
                f"UPDATE invoices SET {set_clause} "
                f"WHERE id IN ({placeholders_for(len(chunk))}) "
                "AND deleted_at IS NULL",
                [*params, *chunk],
            )
            updated_count += cursor.rowcount
    logger.info(
        "Bulk update completed: %d of %d invoices updated (first ids=%s)",
        updated_count,
        len(invoice_ids),
        invoice_ids[:LOG_ID_SAMPLE],
    )
    return jsonify({"success": True, "updated": updated_count})


@invoices_bp.route("/api/invoices/bulk-delete", methods=["POST"])
def bulk_delete_invoices() -> ApiResponse:
    """Soft-delete multiple invoices at once."""
    data: Any = request.json
    try:
        invoice_ids: list[int] = parse_id_list(data)
    except ValidationError as e:
        return error_response(e.message, 400)

    with db_cursor() as cursor:
        # Soft delete: set deleted_at timestamp instead of removing from database
        deleted_count: int = 0
        for chunk in chunked(invoice_ids):
            cursor.execute(
                "UPDATE invoices SET deleted_at = CURRENT_TIMESTAMP "
                f"WHERE id IN ({placeholders_for(len(chunk))}) "
                "AND deleted_at IS NULL",
                chunk,
            )
            deleted_count += cursor.rowcount
    logger.info(
        "Bulk soft-delete completed: %d of %d invoices deleted (first ids=%s)",
        deleted_count,
        len(invoice_ids),
        invoice_ids[:LOG_ID_SAMPLE],
    )
    return jsonify({"success": True, "deleted": deleted_count})
