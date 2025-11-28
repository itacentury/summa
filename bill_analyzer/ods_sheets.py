"""
ODS sheet operations
"""

from datetime import date
from typing import Any

import dateutil.parser as dparser
from odf import table, text
from odf.namespaces import TABLENS

from .config import COL_DATE, COL_STORE, COL_TOTAL
from .ods_cells import get_cell_value, set_cell_value


def find_sheet_by_name(doc: Any, sheet_name: str) -> table.Table | None:
    """
    Find a sheet in an ODS document by name.

    Args:
        doc: ODS document object
        sheet_name: Name of the sheet to find

    Returns:
        Sheet object if found, None otherwise
    """
    sheets = doc.spreadsheet.getElementsByType(table.Table)
    for sheet in sheets:
        if sheet.getAttrNS(TABLENS, "name") == sheet_name:
            return sheet
    return None


def find_date_row(sheet: table.Table, target_date: date) -> int | None:
    """
    Find the row index containing a specific date.

    Handles both:
    - New format: date-value attribute with ISO format (YYYY-MM-DD)
    - Old format: text content with German format (DD.MM.YY)

    Args:
        sheet: ODS sheet to search
        target_date: Date to find

    Returns:
        Row index if found, None otherwise
    """
    rows = sheet.getElementsByType(table.TableRow)

    for idx, row in enumerate(rows):
        cells = row.getElementsByType(table.TableCell)
        if len(cells) <= COL_DATE:
            continue

        cell_value = get_cell_value(cells[COL_DATE])

        # Try to parse as date (handles both ISO and German formats)
        try:
            if isinstance(cell_value, str) and cell_value.strip():
                cell_date = dparser.parse(cell_value, dayfirst=True).date()
                if cell_date == target_date:
                    return idx
        except Exception:
            pass

    return None


def create_new_date_row(sheet: table.Table, new_date: date, doc: Any) -> int:
    """
    Create a new row after the last entry with the given date.
    Inserts a blank separator row before the new date row.

    Args:
        sheet: ODS sheet to add row to
        new_date: Date to insert
        doc: ODS document object (needed for date style)

    Returns:
        Index of the newly created date row
    """
    rows = sheet.getElementsByType(table.TableRow)

    # Find the last row with actual data and determine number of cells needed
    last_data_row_idx = None
    template_cells = None
    num_cells_to_create = COL_TOTAL + 1  # Default: at least 6 cells

    for idx, row in enumerate(rows):
        cells = row.getElementsByType(table.TableCell)
        if len(cells) <= COL_TOTAL:
            continue

        # Update number of cells to create based on existing rows
        # Limit to 10 to avoid issues with repeated columns
        if len(cells) > num_cells_to_create and len(cells) <= 10:
            num_cells_to_create = len(cells)

        # Check if this row has data in any column
        has_data = False
        for col_idx in range(COL_STORE, COL_TOTAL + 1):
            if col_idx < len(cells):
                cell_value = get_cell_value(cells[col_idx])
                if cell_value and str(cell_value).strip():
                    has_data = True
                    break

        # If this row has data, remember it as last data row and save cell styles
        if has_data:
            last_data_row_idx = idx
            template_cells = cells

    # Determine insertion point (after last data row)
    insert_after_idx = (
        last_data_row_idx if last_data_row_idx is not None else len(rows) - 1
    )
    reference_row = (
        rows[insert_after_idx + 1] if insert_after_idx + 1 < len(rows) else None
    )

    # Create blank separator row (with formatting copied from template)
    blank_row = table.TableRow()

    for col_idx in range(num_cells_to_create):
        blank_cell = table.TableCell()

        # Copy cell style from template if available
        if template_cells and col_idx < len(template_cells):
            cell_style = template_cells[col_idx].getAttrNS(TABLENS, "style-name")
            if cell_style:
                blank_cell.setAttrNS(TABLENS, "style-name", cell_style)

        blank_cell.appendChild(text.P(text=""))
        blank_row.appendChild(blank_cell)

    # Insert blank row
    if reference_row is not None:
        sheet.insertBefore(blank_row, reference_row)
    else:
        sheet.addElement(blank_row)

    # Create new date row (with formatting copied from template)
    date_row = table.TableRow()

    for col_idx in range(num_cells_to_create):
        new_cell = table.TableCell()

        # Copy cell style from template if available (but NOT for date column)
        if template_cells and col_idx < len(template_cells) and col_idx != COL_DATE:
            cell_style = template_cells[col_idx].getAttrNS(TABLENS, "style-name")
            if cell_style:
                new_cell.setAttrNS(TABLENS, "style-name", cell_style)

        if col_idx == COL_DATE:
            # Insert date as proper date object (not just text)
            set_cell_value(new_cell, new_date, doc)
        else:
            new_cell.appendChild(text.P(text=""))

        date_row.appendChild(new_cell)

    # Insert date row (after blank row)
    if reference_row is not None:
        sheet.insertBefore(date_row, reference_row)
    else:
        sheet.addElement(date_row)

    # Reload rows and find the index of the new date row
    updated_rows = sheet.getElementsByType(table.TableRow)

    # Find the new date row by looking for our date value (in ISO format from date-value attribute)
    target_date_iso = new_date.strftime("%Y-%m-%d")
    for idx, row in enumerate(updated_rows):
        cells = row.getElementsByType(table.TableCell)
        if len(cells) > COL_DATE:
            cell_value = get_cell_value(cells[COL_DATE])
            if isinstance(cell_value, str) and cell_value == target_date_iso:
                return idx

    # Fallback: return the row before last (should be our new row)
    return len(updated_rows) - 1


def has_existing_data(cells: list[table.TableCell]) -> bool:
    """
    Check if a row has existing data in store/item columns.

    Args:
        cells: List of cells to check

    Returns:
        True if data exists, False otherwise
    """
    for col_idx in range(COL_STORE, COL_TOTAL):
        if col_idx >= len(cells):
            continue
        cell_value = get_cell_value(cells[col_idx])
        if cell_value and str(cell_value).strip():
            return True
    return False
