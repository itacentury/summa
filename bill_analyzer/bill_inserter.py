"""
Main logic for inserting bill data into ODS files
"""

# pyright: reportGeneralTypeIssues=false

import datetime as dt
from dataclasses import dataclass
from typing import Any

import dateutil.parser as dparser
from odf import table, text
from odf.namespaces import TABLENS
from odf.opendocument import OpenDocument, load
from . import config

# from .config import COL_DATE, COL_ITEM, COL_PRICE, COL_STORE, COL_TOTAL, ODS_FILE
from .ods_cells import clear_cell_completely, get_cell_value, set_cell_value
from .ods_rows import create_item_row
from .ods_sheets import (
    find_chronological_insertion_point,
    find_date_row,
    find_last_row,
    find_sheet_by_name,
)
from .utils import (
    create_backup,
    extract_price_number,
    is_number,
    parse_date,
    remove_backup,
    restore_from_backup,
)

# Export the duplicate check function for use in other modules
__all__ = ["process_multiple_bills", "check_duplicate_bill"]


@dataclass
class _BillSearchCriteria:
    """Criteria for searching bills during duplicate detection."""

    date_str: str  # ISO format date string (YYYY-MM-DD)
    store_normalized: str  # Lowercase, trimmed store name
    total: float  # Total bill amount
    epsilon: float = 0.01  # Float comparison tolerance


def _has_matching_date(cells: list[table.TableCell], target_date_str: str) -> bool:
    """
    Check if a row contains a date matching the target date.
    Returns True if the row's date matches the target date, False otherwise.
    """
    if len(cells) <= config.COL_DATE:
        return False

    # Get date value
    date_value: str = get_cell_value(cells[config.COL_DATE])

    # Parse and check date
    if not date_value:
        return False

    row_date: str | None = parse_date(date_value)

    if row_date is None:
        return False

    # Check if date matches
    return row_date == target_date_str


def _get_store_from_bill_start(
    rows: list[table.TableRow], start_idx: int, store: str
) -> int | None:
    """Search for a matching store name within a bill group starting from a given row.

    This function scans rows starting from start_idx to find a row containing
    the specified store name. It stops when it encounters another date entry
    (indicating the start of a different bill) or reaches the end of rows.

    Returns row index containing the matching store, or None if not found
    """
    for idx in range(start_idx, len(rows)):
        cells: list[table.TableCell] = rows[idx].getElementsByType(table.TableCell)

        if len(cells) <= config.COL_STORE:
            continue

        if start_idx != idx and get_cell_value(cells[config.COL_DATE]):
            return None

        found_store: str = get_cell_value(cells[config.COL_STORE])
        if not found_store:
            continue

        found_store = found_store.strip().lower()
        if found_store != store:
            continue

        return idx

    return None


def _find_total_in_bill_group(
    rows: list[table.TableRow], start_idx: int, total: float
) -> int | None:
    """Search for a matching total price within a bill group starting from a given row.

    This function scans rows starting from start_idx to find a row containing
    the specified total amount. It stops when it encounters a new bill marker
    (date or store entry on a different row) or reaches the end of rows.

    Returns row index containing the matching total, or None if not found or mismatch
    """
    for idx in range(start_idx, len(rows)):
        cells: list[table.TableCell] = rows[idx].getElementsByType(table.TableCell)

        if len(cells) <= config.COL_TOTAL:
            continue

        if start_idx != idx and (
            get_cell_value(cells[config.COL_DATE])
            or get_cell_value(cells[config.COL_STORE])
        ):
            return None

        found_total: str = get_cell_value(cells[config.COL_TOTAL])
        if not found_total:
            continue

        found_total = extract_price_number(found_total)
        if not is_number(found_total):
            continue

        if float(found_total) != total:
            return None

        return idx

    return None


def _process_bill_row_for_duplicate(
    rows: list[table.TableRow],
    start_idx: int,
    criteria: _BillSearchCriteria,
) -> bool:
    """
    Process a single row to check if it represents a duplicate bill.
    Returns True if a matching duplicate bill is found, False otherwise.
    """
    cells: list[table.TableCell] = rows[start_idx].getElementsByType(table.TableCell)

    if not _has_matching_date(cells, criteria.date_str):
        return False

    idx: int = start_idx
    new_idx: int | None = None
    end_idx: int = -1

    # get index of next date row, to indicate end of bill entries for the current date
    for i in range(start_idx + 1, len(rows)):
        search_cells: list[table.TableCell] = rows[i].getElementsByType(table.TableCell)

        if len(search_cells) <= config.COL_DATE:
            continue

        if get_cell_value(search_cells[config.COL_DATE]):
            end_idx = i
            break

    while new_idx is None:
        new_idx = _get_store_from_bill_start(rows, idx, criteria.store_normalized)
        if new_idx is None:
            return False

        # same date bill entries cannot be above the date row (smaller index)
        if new_idx < start_idx:
            return False

        # if index is at or beyond a new date row, return
        # duplicates must have the same date
        if end_idx != -1 and new_idx >= end_idx:
            return False

        idx = new_idx
        new_idx = _find_total_in_bill_group(rows, idx, criteria.total)
        idx += 1

    return True


def _check_duplicate_bill(doc: OpenDocument, bill_data: dict[str, Any]) -> bool:
    """Check if a bill with same store, date, and total already exists.

    This function searches for bill entries that span multiple rows.
    Each bill starts with a row containing the store, followed by
    item rows, with the total appearing in the last row.

    Returns True if duplicate exists, False otherwise
    """
    # Parse date and determine sheet name
    date_parsed: dt.datetime = dparser.parse(bill_data["date"], dayfirst=True)
    sheet_name: str = f"{date_parsed.strftime('%b')} {date_parsed.strftime('%y')}"

    # Find sheet
    target_sheet: table.Table | None = find_sheet_by_name(doc, sheet_name)
    if not target_sheet:
        return False

    # Prepare search criteria
    criteria: _BillSearchCriteria = _BillSearchCriteria(
        date_str=date_parsed.date().strftime("%Y-%m-%d"),
        store_normalized=bill_data["store"].strip().lower(),
        total=bill_data["total"],
    )

    # Search for bills on the target date
    rows: list[table.TableRow] = target_sheet.getElementsByType(table.TableRow)

    for idx in range(len(rows)):
        if _process_bill_row_for_duplicate(rows, idx, criteria):
            return True  # Duplicate found

    return False


def _find_target_sheet_and_row(
    doc: OpenDocument, bill_data: dict[str, Any]
) -> tuple[table.Table | None, int | None]:
    """
    Find or create the target sheet and row for bill insertion.
    """
    date_parsed: Any = dparser.parse(bill_data["date"], dayfirst=True)
    month: str = date_parsed.strftime("%b")
    year: str = date_parsed.strftime("%y")
    sheet_name: str = f"{month} {year}"

    target_sheet: table.Table | None = find_sheet_by_name(doc, sheet_name)
    if not target_sheet:
        return None, None

    target_row_idx: int | None = find_date_row(target_sheet, date_parsed.date())

    return target_sheet, target_row_idx


def _insert_single_bill_data(doc: OpenDocument, bill_data: dict[str, Any]) -> None:
    """
    Docstring for _insert_bill

    :param doc: Description
    :type doc: OpenDocument
    :param bill_data: Description
    :type bill_data: dict[str, Any]
    """

    target_sheet, target_row_idx = _find_target_sheet_and_row(doc, bill_data)
    if target_sheet is None:
        return

    rows: list[table.TableRow] = target_sheet.getElementsByType(table.TableRow)
    if target_row_idx is None:
        # no row with date found, find last row
        target_row_idx = find_chronological_insertion_point(rows, bill_data["date"])
        if target_row_idx is None:
            target_row_idx = find_last_row(rows) + 2

    target_row: table.TableRow = rows[target_row_idx]
    cells: list[table.TableCell] = target_row.getElementsByType(table.TableCell)
    row_style: str | None = target_row.getAttrNS(TABLENS, "style-name")

    if len(cells) >= config.COL_DATE:
        clear_cell_completely(cells[config.COL_DATE])

    # create first new row with date and bill data
    date_row: table.TableRow = table.TableRow()
    for col_idx in range(config.COL_TOTAL + 1):
        new_cell: table.TableCell = table.TableCell()
        match col_idx:
            case config.COL_DATE:
                set_cell_value(new_cell, bill_data["date"], doc)
            case config.COL_STORE:
                set_cell_value(new_cell, bill_data["store"])
            case config.COL_ITEM:
                set_cell_value(new_cell, bill_data["items"][0]["name"])
            case config.COL_PRICE:
                set_cell_value(new_cell, bill_data["items"][0]["price"])
            case config.COL_TOTAL:
                if len(bill_data["items"]) == 1:
                    set_cell_value(new_cell, bill_data["total"])
            case _:
                new_cell.appendChild(text.P(text=""))

        date_row.appendChild(new_cell)
    target_sheet.insertBefore(date_row, target_row)

    # if bill has only one item we are done
    # total has already been inserted, see above
    # insert empty seperator row
    if len(bill_data["items"]) <= 1:
        target_sheet.insertBefore(table.TableRow(), target_row)
        return

    # add bill data for remaining items
    remaining_items = bill_data["items"][1:]
    for item in remaining_items:
        is_last_item = item == remaining_items[-1]
        total = bill_data["total"] if is_last_item else None

        new_row = create_item_row(
            cells, row_style, item["name"], item["price"], total_price=total
        )
        target_sheet.insertBefore(new_row, target_row)

    # empty seperator row
    target_sheet.insertBefore(table.TableRow(), target_row)


def process_multiple_bills(bills_data: list[dict[str, Any]]) -> None:
    """Process multiple bills and insert them into the ODS file in a single transaction.

    This function:
    1. Creates a backup of the ODS file (once)
    2. Loads the document (once)
    3. Sorts bills by date (chronologically)
    4. Inserts all bills into the document
    5. Saves the document (once)
    6. Removes backup on success

    :param bills_data: List of bill dictionaries, each containing 'store', 'date', 'items', 'total'
    :type bills_data: list[dict[str, Any]]
    :raises Exception: If any step fails (backup is automatically restored)
    """
    if not bills_data:
        print("No bills to process.")
        return

    # Sort bills by date (chronologically) to ensure correct insertion order
    sorted_bills: list[dict[str, Any]] = sorted(
        bills_data, key=lambda bill: dparser.parse(bill["date"], dayfirst=True).date()
    )

    # Create backup
    backup_path: str = create_backup(config.ODS_FILE)

    try:
        # Load document once
        print("Loading ODS file...")
        doc: OpenDocument = load(config.ODS_FILE)

        # Insert all bills in chronological order
        for idx, bill_data in enumerate(sorted_bills, 1):
            print(
                f"\n[{idx}/{len(sorted_bills)}] Processing {bill_data.get('store', 'Unknown')}..."
            )
            _insert_single_bill_data(doc, bill_data)

        # Save document once
        print("\nSaving all changes to document...")
        doc.save(config.ODS_FILE)
        print(f"✓ Successfully saved {len(bills_data)} bill(s) to {config.ODS_FILE}")

        # Remove backup
        remove_backup(backup_path)

    except Exception as e:
        print(f"✗ Error: {e}")
        restore_from_backup(backup_path, config.ODS_FILE)
        raise


def check_duplicate_bill(bill_data: dict[str, Any]) -> bool:
    """Check if a bill is a duplicate by loading and checking the ODS file.

    This is a convenience function that loads the ODS file, checks for duplicates,
    and returns the result. Use this before uploading to external services.

    :param bill_data: Dictionary containing 'store', 'date', 'items', 'total'
    :type bill_data: dict[str, Any]
    :return: True if duplicate exists, False otherwise
    :rtype: bool
    :raises Exception: If ODS file cannot be loaded
    """
    doc: OpenDocument = load(config.ODS_FILE)
    return _check_duplicate_bill(doc, bill_data)
