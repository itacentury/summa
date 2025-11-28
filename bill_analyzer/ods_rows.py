"""
ODS row operations
"""

from typing import Any

from odf import table, text
from odf.namespaces import TABLENS

from .config import COL_ITEM, COL_PRICE, COL_STORE, COL_TOTAL
from .ods_cells import create_empty_cell_with_style, set_cell_value


def create_item_row(
    template_cells: list[table.TableCell],
    template_row_style: str | None,
    item_name: str,
    item_price: float,
    store_name: str | None = None,
    total_price: float | None = None,
) -> table.TableRow:
    """
    Create a new row for a bill item with proper formatting.

    Args:
        template_cells: List of cells to copy styles from
        template_row_style: Row style to apply
        item_name: Name of the item
        item_price: Price of the item
        store_name: Store name (only for first row)
        total_price: Total price (only for last row)

    Returns:
        New table row with all cells properly formatted
    """
    new_row = table.TableRow()

    # Set row style
    if template_row_style:
        new_row.setAttrNS(TABLENS, "style-name", template_row_style)

    # Create cells for each column
    for col_idx in range(len(template_cells)):
        new_cell = table.TableCell()

        # Copy cell style
        cell_style = template_cells[col_idx].getAttrNS(TABLENS, "style-name")
        if cell_style:
            new_cell.setAttrNS(TABLENS, "style-name", cell_style)

        # Set cell content based on column
        if col_idx == COL_STORE and store_name:
            set_cell_value(new_cell, store_name)
        elif col_idx == COL_ITEM:
            set_cell_value(new_cell, item_name)
        elif col_idx == COL_PRICE:
            set_cell_value(new_cell, item_price)
        elif col_idx == COL_TOTAL and total_price:
            set_cell_value(new_cell, total_price)
        else:
            new_cell.appendChild(text.P(text=""))

        new_row.appendChild(new_cell)

    return new_row


def create_blank_separator_row(
    template_cells: list[table.TableCell], template_row_style: str | None
) -> table.TableRow:
    """
    Create a blank row to separate different bills on the same date.

    Args:
        template_cells: List of cells to copy styles from
        template_row_style: Row style to apply

    Returns:
        New blank table row with proper formatting
    """
    blank_row = table.TableRow()

    if template_row_style:
        blank_row.setAttrNS(TABLENS, "style-name", template_row_style)

    for cell in template_cells:
        blank_cell = create_empty_cell_with_style(cell)
        blank_row.appendChild(blank_cell)

    return blank_row


def save_existing_row_data(
    cells: list[table.TableCell],
) -> list[tuple[Any, str | None]]:
    """
    Save all data and styles from a row before modifying it.

    Args:
        cells: List of cells to save

    Returns:
        List of tuples (cell_value, cell_style)
    """
    from .ods_cells import get_cell_value

    row_data = []
    for cell in cells:
        cell_value = get_cell_value(cell)
        cell_style = cell.getAttrNS(TABLENS, "style-name")
        row_data.append((cell_value, cell_style))
    return row_data


def restore_row_as_new(
    old_row_data: list[tuple[Any, str | None]],
    template_row_style: str | None,
) -> table.TableRow:
    """
    Create a new row from saved row data.

    Args:
        old_row_data: List of tuples (cell_value, cell_style) from save_existing_row_data()
        template_row_style: Row style to apply

    Returns:
        New table row with restored data
    """
    old_row = table.TableRow()

    if template_row_style:
        old_row.setAttrNS(TABLENS, "style-name", template_row_style)

    for col_idx, (old_value, old_style) in enumerate(old_row_data):
        new_cell = table.TableCell()

        if old_style:
            new_cell.setAttrNS(TABLENS, "style-name", old_style)

        # Skip date columns (0 and 1), only preserve columns 2+
        if col_idx >= COL_STORE and old_value and str(old_value).strip():
            set_cell_value(new_cell, old_value)
        else:
            new_cell.appendChild(text.P(text=""))

        old_row.appendChild(new_cell)

    return old_row
