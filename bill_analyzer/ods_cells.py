"""
ODS cell operations
"""

from datetime import date
from datetime import datetime as dt
from typing import Any

from odf import table, text
from odf.namespaces import OFFICENS, TABLENS

from .config import (
    CALCEXT_ATTRS_TO_CLEAR,
    CALCEXT_NS,
    OFFICE_ATTRS_TO_CLEAR,
    TABLE_ATTRS_TO_CLEAR,
)
from .ods_styles import ensure_date_style_exists


def get_cell_value(cell: table.TableCell) -> Any:
    """
    Extract the value from an ODS cell.

    Tries multiple attribute types (value, date-value, string-value)
    and falls back to text content if no attributes are found.

    Args:
        cell: ODS table cell

    Returns:
        Cell value (float, str, or empty string)
    """
    # Try numeric value
    value_attr = cell.getAttrNS(OFFICENS, "value")
    if value_attr:
        return float(value_attr)

    # Try date value
    date_value_attr = cell.getAttrNS(OFFICENS, "date-value")
    if date_value_attr:
        return date_value_attr

    # Try string value
    string_value_attr = cell.getAttrNS(OFFICENS, "string-value")
    if string_value_attr:
        return string_value_attr

    # Fallback: get text content
    text_content = []
    for p_element in cell.getElementsByType(text.P):
        text_content.append(str(p_element))
    return "".join(text_content) if text_content else ""


def set_cell_value(cell: table.TableCell, value: Any, doc: Any | None = None) -> None:
    """
    Set value in an ODS cell while preserving its style.

    Args:
        cell: ODS table cell
        value: Value to set (can be string, number, date, or datetime)
        doc: Optional ODS document (required for date values to apply proper formatting)
    """
    # Clear existing content
    for child in list(cell.childNodes):
        try:
            cell.removeChild(child)
        except ValueError:
            # Handle case where element is not in the document's internal cache
            # This can happen when cells have been previously manipulated
            pass

    # Handle different value types
    # Note: Check datetime before date since datetime is a subclass of date
    if isinstance(value, dt):
        # Datetime object - store as date with ISO format
        date_iso = value.strftime("%Y-%m-%d")
        date_display = value.strftime("%d.%m.%y")

        p = text.P(text=date_display)
        cell.appendChild(p)

        cell.setAttrNS(OFFICENS, "value-type", "date")
        cell.setAttrNS(OFFICENS, "date-value", date_iso)

        # Apply date-only style if doc is provided
        if doc:
            style_name = ensure_date_style_exists(doc)
            cell.setAttrNS(TABLENS, "style-name", style_name)
    elif isinstance(value, date):
        # Date object - store as date with ISO format
        date_iso = value.strftime("%Y-%m-%d")

        # Don't set display text - let the style format it
        p = text.P(text="")
        cell.appendChild(p)

        cell.setAttrNS(OFFICENS, "value-type", "date")
        cell.setAttrNS(OFFICENS, "date-value", date_iso)

        # Apply date-only style if doc is provided
        if doc:
            style_name = ensure_date_style_exists(doc)
            cell.setAttrNS(TABLENS, "style-name", style_name)
    elif isinstance(value, (int, float)):
        # Numeric value
        p = text.P(text=str(value))
        cell.appendChild(p)

        cell.setAttrNS(OFFICENS, "value-type", "float")
        cell.setAttrNS(OFFICENS, "value", str(value))
    else:
        # String value
        p = text.P(text=str(value))
        cell.appendChild(p)

        cell.setAttrNS(OFFICENS, "value-type", "string")


def clear_cell_completely(cell: table.TableCell) -> None:
    """
    Clear all content and value attributes from an ODS cell.

    This removes:
    - All child nodes (text content)
    - All office: value attributes (value, value-type, currency, etc.)
    - Table formulas
    - LibreOffice Calc extension attributes

    Args:
        cell: ODS table cell to clear
    """
    # Remove all child nodes
    for child in list(cell.childNodes):
        try:
            cell.removeChild(child)
        except ValueError:
            # Handle case where element is not in the document's internal cache
            # This can happen when cells have been previously manipulated
            pass

    # Remove office: value attributes
    for attr_name in OFFICE_ATTRS_TO_CLEAR:
        try:
            cell.removeAttrNS(OFFICENS, attr_name)
        except KeyError:
            pass

    # Remove table: formula attributes
    for attr_name in TABLE_ATTRS_TO_CLEAR:
        try:
            cell.removeAttrNS(TABLENS, attr_name)
        except KeyError:
            pass

    # Remove LibreOffice Calc extension attributes
    for attr_name in CALCEXT_ATTRS_TO_CLEAR:
        try:
            cell.removeAttrNS(CALCEXT_NS, attr_name)
        except KeyError:
            pass


def create_empty_cell_with_style(
    reference_cell: table.TableCell,
) -> table.TableCell:
    """
    Create a new empty cell with the same style as a reference cell.

    Args:
        reference_cell: Cell to copy style from

    Returns:
        New empty cell with copied style
    """
    new_cell = table.TableCell()

    # Copy style
    cell_style = reference_cell.getAttrNS(TABLENS, "style-name")
    if cell_style:
        new_cell.setAttrNS(TABLENS, "style-name", cell_style)

    # Add empty paragraph
    new_cell.appendChild(text.P(text=""))

    return new_cell
