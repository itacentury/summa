"""
Main logic for inserting bill data into ODS files
"""

from typing import Any

import dateutil.parser as dparser
from odf import table
from odf.namespaces import TABLENS
from odf.opendocument import load

from .config import COL_ITEM, COL_PRICE, COL_STORE, COL_TOTAL, ODS_FILE
from .file_utils import create_backup, remove_backup, restore_from_backup
from .ods_cells import clear_cell_completely, set_cell_value
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


def insert_bill_into_ods(bill_data: dict[str, Any]) -> None:
    """
    Insert bill data into the ODS file.

    This function:
    1. Creates a backup of the ODS file
    2. Finds the correct sheet and row based on date
    3. Overwrites the date row with new data
    4. Inserts additional item rows
    5. Moves existing data down with a separator
    6. Saves the document and removes backup on success

    Args:
        bill_data: Dictionary containing 'store', 'date', 'item', 'total'

    Raises:
        Exception: If any step fails (backup is automatically restored)
    """
    # Parse date and determine sheet name
    date_parsed = dparser.parse(bill_data["date"], dayfirst=True)
    month = date_parsed.strftime("%b")
    year = date_parsed.strftime("%y")
    sheet_name = f"{month} {year}"

    # Create backup
    backup_path = create_backup(ODS_FILE)

    try:
        # Load document
        print(f"Loading ODS file...")
        doc = load(ODS_FILE)

        # Find sheet
        target_sheet = find_sheet_by_name(doc, sheet_name)
        if not target_sheet:
            print(f"⚠ Sheet '{sheet_name}' not found")
            return

        # Find or create date row
        target_row_idx = find_date_row(target_sheet, date_parsed.date())
        if target_row_idx is None:
            # Date not found - create new row at the end
            print(f"Creating new row for date {date_parsed.date()}")
            target_row_idx = create_new_date_row(target_sheet, date_parsed.date(), doc)

        # Get row and cells
        rows = target_sheet.getElementsByType(table.TableRow)
        target_row = rows[target_row_idx]
        cells = target_row.getElementsByType(table.TableCell)
        row_style = target_row.getAttrNS(TABLENS, "style-name")

        # Save existing data (will be empty for newly created rows)
        old_data_exists = has_existing_data(cells)
        old_row_data = save_existing_row_data(cells) if old_data_exists else None

        # Overwrite date row with first item
        first_item = bill_data["items"][0]
        set_cell_value(cells[COL_STORE], bill_data["store"])
        set_cell_value(cells[COL_ITEM], first_item["name"])
        set_cell_value(cells[COL_PRICE], first_item["price"])

        # Clear total column
        for col_idx in range(COL_TOTAL, len(cells)):
            clear_cell_completely(cells[col_idx])

        # Add total if only one item
        if len(bill_data["items"]) == 1 and len(cells) > COL_TOTAL:
            set_cell_value(cells[COL_TOTAL], bill_data["total"])

        # Insert remaining items as new rows
        reference_row = (
            rows[target_row_idx + 1] if target_row_idx + 1 < len(rows) else None
        )

        remaining_items = bill_data["items"][1:]
        for idx, item in enumerate(remaining_items):
            is_last_item = idx == len(remaining_items) - 1
            total = bill_data["total"] if is_last_item else None

            new_row = create_item_row(
                cells, row_style, item["name"], item["price"], total_price=total
            )

            if reference_row is not None:
                target_sheet.insertBefore(new_row, reference_row)
            else:
                target_sheet.addElement(new_row)

        # Insert separator and old data if it exists
        if old_data_exists:
            blank_row = create_blank_separator_row(cells, row_style)
            if reference_row is not None:
                target_sheet.insertBefore(blank_row, reference_row)
            else:
                target_sheet.addElement(blank_row)

            old_row = restore_row_as_new(old_row_data, row_style)
            if reference_row is not None:
                target_sheet.insertBefore(old_row, reference_row)
            else:
                target_sheet.addElement(old_row)

        print(
            f"✓ Inserted {len(bill_data['items'])} items + total for {bill_data['store']}"
        )

        # Save document
        print("Saving document...")
        doc.save(ODS_FILE)
        print(f"✓ Successfully saved to {ODS_FILE}")

        # Remove backup
        remove_backup(backup_path)

    except Exception as e:
        print(f"✗ Error: {e}")
        restore_from_backup(backup_path, ODS_FILE)
        raise
