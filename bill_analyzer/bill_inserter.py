"""
Main logic for inserting bill data into ODS files
"""

# pyright: reportGeneralTypeIssues=false

from typing import Any

import dateutil.parser as dparser
from odf import table
from odf.namespaces import TABLENS
from odf.opendocument import load

from .config import COL_DATE, COL_ITEM, COL_PRICE, COL_STORE, COL_TOTAL, ODS_FILE
from .file_utils import create_backup, remove_backup, restore_from_backup
from .ods_cells import clear_cell_completely, get_cell_value, set_cell_value
from .ods_rows import (
    create_blank_separator_row,
    create_item_row,
    restore_row_as_new,
    save_existing_row_data,
)
from .ods_sheets import (
    create_new_date_row,
    find_date_row,
    find_sheet_by_name,
    has_existing_data,
)


def _row_matches_bill(  # pylint: disable=too-many-return-statements
    cells: list[table.TableCell],
    target_date_str: str,
    target_store: str,
    target_total: float,
) -> bool:
    """Check if a row matches the target bill criteria.

    :param cells: Row cells to check
    :param target_date_str: Target date in ISO format (YYYY-MM-DD)
    :param target_store: Target store name
    :param target_total: Target total amount
    :return: True if row matches, False otherwise
    """
    if len(cells) <= max(COL_STORE, COL_TOTAL):
        return False

    # Get cell values
    date_value: Any = get_cell_value(cells[COL_DATE])
    store_value: Any = get_cell_value(cells[COL_STORE])
    total_value: Any = get_cell_value(cells[COL_TOTAL])

    # Parse and check date
    try:
        if not isinstance(date_value, str) or not date_value.strip():
            return False
        row_date = dparser.parse(date_value, dayfirst=True).date()
        row_date_str = row_date.strftime("%Y-%m-%d")
    except (ValueError, TypeError, OverflowError):
        return False

    # Check if date and store match
    if row_date_str != target_date_str or store_value != target_store:
        return False

    # Check if total matches
    if total_value is None:
        return False

    try:
        return float(total_value) == target_total
    except (ValueError, TypeError):
        return False


def _check_duplicate_bill(doc: Any, bill_data: dict[str, Any]) -> bool:
    """Check if a bill with same store, date, and total already exists.

    :param doc: ODS document object
    :type doc: Any
    :param bill_data: Bill data dictionary
    :type bill_data: dict[str, Any]
    :return: True if duplicate exists, False otherwise
    :rtype: bool
    """
    # Parse date and determine sheet name
    date_parsed = dparser.parse(bill_data["date"], dayfirst=True)
    sheet_name = f"{date_parsed.strftime('%b')} {date_parsed.strftime('%y')}"

    # Find sheet
    target_sheet = find_sheet_by_name(doc, sheet_name)
    if not target_sheet:
        return False

    # Prepare search criteria
    target_date_str = date_parsed.date().strftime("%Y-%m-%d")
    target_store = bill_data["store"]
    target_total = bill_data["total"]

    # Search for matching row
    rows = target_sheet.getElementsByType(table.TableRow)
    for row in rows:
        cells = row.getElementsByType(table.TableCell)
        if _row_matches_bill(cells, target_date_str, target_store, target_total):
            return True

    return False


def _find_target_sheet_and_row(
    doc: Any, bill_data: dict[str, Any], verbose: bool
) -> tuple[table.Table | None, int | None]:
    """Find or create the target sheet and row for bill insertion.

    :param doc: ODS document object
    :type doc: Any
    :param bill_data: Bill data dictionary
    :type bill_data: dict[str, Any]
    :param verbose: Whether to print messages
    :type verbose: bool
    :return: Tuple of (target_sheet, target_row_idx) or (None, None) if sheet not found
    :rtype: tuple[table.Table | None, int | None]
    """
    # Parse date and determine sheet name
    date_parsed: Any = dparser.parse(bill_data["date"], dayfirst=True)
    month: str = date_parsed.strftime("%b")
    year: str = date_parsed.strftime("%y")
    sheet_name: str = f"{month} {year}"

    # Find sheet
    target_sheet: table.Table | None = find_sheet_by_name(doc, sheet_name)
    if not target_sheet:
        if verbose:
            print(f"⚠ Sheet '{sheet_name}' not found - skipping bill")
        return None, None

    # Find or create date row
    target_row_idx: int | None = find_date_row(target_sheet, date_parsed.date())
    if target_row_idx is None:
        if verbose:
            print(f"Creating new row for date {date_parsed.date()}")
        target_row_idx = create_new_date_row(target_sheet, date_parsed.date(), doc)

    return target_sheet, target_row_idx


def _write_first_bill_item(
    cells: list[table.TableCell], bill_data: dict[str, Any]
) -> None:
    """Write the first bill item to the target row.

    :param cells: List of cells in the target row
    :type cells: list[table.TableCell]
    :param bill_data: Bill data dictionary
    :type bill_data: dict[str, Any]
    """
    first_item: dict[str, Any] = bill_data["items"][0]
    set_cell_value(cells[COL_STORE], bill_data["store"])
    set_cell_value(cells[COL_ITEM], first_item["name"])
    set_cell_value(cells[COL_PRICE], first_item["price"])

    # Clear total column
    for col_idx in range(COL_TOTAL, len(cells)):
        clear_cell_completely(cells[col_idx])

    # Add total if only one item
    if len(bill_data["items"]) == 1 and len(cells) > COL_TOTAL:
        set_cell_value(cells[COL_TOTAL], bill_data["total"])


def _insert_remaining_items(
    target_sheet: table.Table,
    cells: list[table.TableCell],
    row_style: str | None,
    bill_data: dict[str, Any],
    reference_row: table.TableRow | None,
) -> None:
    """Insert remaining bill items as new rows.

    :param target_sheet: Target ODS sheet
    :type target_sheet: table.Table
    :param cells: Template cells for styling
    :type cells: list[table.TableCell]
    :param row_style: Row style to apply
    :type row_style: str | None
    :param bill_data: Bill data dictionary
    :type bill_data: dict[str, Any]
    :param reference_row: Row to insert before (or None to append)
    :type reference_row: table.TableRow | None
    """
    remaining_items: list[dict[str, Any]] = bill_data["items"][1:]
    for idx, item in enumerate(remaining_items):
        is_last_item: bool = idx == len(remaining_items) - 1
        total: float | None = bill_data["total"] if is_last_item else None

        new_row: table.TableRow = create_item_row(
            cells, row_style, item["name"], item["price"], total_price=total
        )

        if reference_row is not None:
            target_sheet.insertBefore(new_row, reference_row)
        else:
            target_sheet.addElement(new_row)


def _restore_old_data(
    target_sheet: table.Table,
    old_row_data: list[tuple[Any, str | None]],
    cells: list[table.TableCell],
    row_style: str | None,
    reference_row: table.TableRow | None,
) -> None:
    """Restore old row data that existed before overwriting.

    :param target_sheet: Target ODS sheet
    :type target_sheet: table.Table
    :param old_row_data: Saved old row data (must not be None)
    :type old_row_data: list[tuple[Any, str | None]]
    :param cells: Template cells for styling
    :type cells: list[table.TableCell]
    :param row_style: Row style to apply
    :type row_style: str | None
    :param reference_row: Row to insert before (or None to append)
    :type reference_row: table.TableRow | None
    """
    blank_row: table.TableRow = create_blank_separator_row(cells, row_style)
    if reference_row is not None:
        target_sheet.insertBefore(blank_row, reference_row)
    else:
        target_sheet.addElement(blank_row)

    old_row: table.TableRow = restore_row_as_new(old_row_data, row_style)
    if reference_row is not None:
        target_sheet.insertBefore(old_row, reference_row)
    else:
        target_sheet.addElement(old_row)


def _insert_single_bill_data(
    doc: Any, bill_data: dict[str, Any], verbose: bool = True
) -> None:
    """Insert a single bill's data into an already-loaded ODS document.

    This is an internal function that performs the actual data insertion
    without handling file I/O (loading/saving/backup).

    :param doc: Loaded ODS document object
    :type doc: Any
    :param bill_data: Dictionary containing 'store', 'date', 'items', 'total'
    :type bill_data: dict[str, Any]
    :param verbose: Whether to print progress messages
    :type verbose: bool
    :raises Exception: If sheet is not found or data insertion fails
    """
    # Check for duplicate bill
    if _check_duplicate_bill(doc, bill_data):
        if verbose:
            print(
                f"⚠ Skipping duplicate: {bill_data['store']} on {bill_data['date']} "
                f"with total {bill_data['total']}€"
            )
        return

    # Find target sheet and row
    target_sheet, target_row_idx = _find_target_sheet_and_row(doc, bill_data, verbose)
    if target_sheet is None or target_row_idx is None:
        return

    # Get row and cells
    rows: list[table.TableRow] = target_sheet.getElementsByType(table.TableRow)
    target_row: table.TableRow = rows[target_row_idx]
    cells: list[table.TableCell] = target_row.getElementsByType(table.TableCell)
    row_style: str | None = target_row.getAttrNS(TABLENS, "style-name")

    # Save existing data (will be empty for newly created rows)
    old_data_exists: bool = has_existing_data(cells)
    old_row_data: list[tuple[Any, str | None]] | None = (
        save_existing_row_data(cells) if old_data_exists else None
    )

    # Write first item to the target row
    _write_first_bill_item(cells, bill_data)

    # Calculate reference row for inserting additional rows
    reference_row: table.TableRow | None = (
        rows[target_row_idx + 1] if target_row_idx + 1 < len(rows) else None
    )

    # Insert remaining items as new rows
    _insert_remaining_items(target_sheet, cells, row_style, bill_data, reference_row)

    # Restore old data if it existed
    if old_data_exists and old_row_data is not None:
        _restore_old_data(target_sheet, old_row_data, cells, row_style, reference_row)

    if verbose:
        print(
            f"✓ Inserted {len(bill_data['items'])} items + total for {bill_data['store']}"
        )


def process_multiple_bills(bills_data: list[dict[str, Any]]) -> None:
    """Process multiple bills and insert them into the ODS file in a single transaction.

    This function:
    1. Creates a backup of the ODS file (once)
    2. Loads the document (once)
    3. Sorts bills by date (chronologically)
    4. Inserts all bills into the document
    5. Saves the document (once)
    6. Removes backup on success

    This is more efficient than calling insert_bill_into_ods() multiple times,
    as it only performs file I/O once instead of for each bill.

    :param bills_data: List of bill dictionaries, each containing 'store', 'date', 'items', 'total'
    :type bills_data: list[dict[str, Any]]
    :raises Exception: If any step fails (backup is automatically restored)
    """
    if not bills_data:
        print("No bills to process.")
        return

    # Sort bills by date (chronologically) to ensure correct insertion order
    sorted_bills = sorted(
        bills_data, key=lambda bill: dparser.parse(bill["date"], dayfirst=True).date()
    )

    # Create backup
    backup_path: str = create_backup(ODS_FILE)

    try:
        # Load document once
        print("Loading ODS file...")
        doc = load(ODS_FILE)

        # Insert all bills in chronological order
        for idx, bill_data in enumerate(sorted_bills, 1):
            print(
                f"\n[{idx}/{len(sorted_bills)}] Processing {bill_data.get('store', 'Unknown')}..."
            )
            _insert_single_bill_data(doc, bill_data, verbose=True)

        # Save document once
        print("\nSaving all changes to document...")
        doc.save(ODS_FILE)
        print(f"✓ Successfully saved {len(bills_data)} bill(s) to {ODS_FILE}")

        # Remove backup
        remove_backup(backup_path)

    except Exception as e:
        print(f"✗ Error: {e}")
        restore_from_backup(backup_path, ODS_FILE)
        raise


def insert_bill_into_ods(bill_data: dict[str, Any]) -> None:
    """Insert a single bill into the ODS file.

    This is a convenience wrapper around process_multiple_bills() for
    processing a single bill. For processing multiple bills, use
    process_multiple_bills() directly for better performance.

    :param bill_data: Dictionary containing 'store', 'date', 'items', 'total'
    :type bill_data: dict[str, Any]
    :raises Exception: If any step fails (backup is automatically restored)
    """
    process_multiple_bills([bill_data])
