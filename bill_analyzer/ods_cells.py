"""
ODS cell operations
"""

# pyright: reportGeneralTypeIssues=false

from datetime import date
from datetime import datetime as dt
from typing import Any

from odf import table, text
from odf.namespaces import OFFICENS, TABLENS
from odf.opendocument import OpenDocument

from .config import (
    CALCEXT_ATTRS_TO_CLEAR,
    CALCEXT_NS,
    OFFICE_ATTRS_TO_CLEAR,
    TABLE_ATTRS_TO_CLEAR,
)
from .ods_styles import ensure_date_style_exists


def get_cell_value(cell: table.TableCell) -> str:
    """Read type-independant cell value"""
    value_type: str = cell.getAttrNS(OFFICENS, "value-type")

    match value_type:
        case "float" | "currency" | "percentage":
            value: str = cell.getAttrNS(OFFICENS, "value")
            return value
        case "string" | "text" | None:
            paragraphs: list[str] = cell.getElementsByType(text.P)
            if paragraphs:
                text_val: str = str(paragraphs[0])
                return text_val
        case "date":
            date_value: str = cell.getAttrNS(OFFICENS, "date-value")
            return date_value
        case "time":
            time_value: str = cell.getAttrNS(OFFICENS, "time-value")
            return time_value
        case "boolean":
            bool_value: str = cell.getAttrNS(OFFICENS, "boolean-value")
            return bool_value

    return ""


def _set_datetime_value(cell: table.TableCell, value: dt, doc: Any | None) -> None:
    """Set a datetime value in a cell.

    :param cell: ODS table cell
    :type cell: table.TableCell
    :param value: Datetime value to set
    :type value: dt
    :param doc: Optional ODS document for date style
    :type doc: Any | None
    """
    date_iso: str = value.strftime("%Y-%m-%d")
    date_display: str = value.strftime("%d.%m.%y")

    p: text.P = text.P(text=date_display)
    cell.appendChild(p)

    cell.setAttrNS(OFFICENS, "value-type", "date")
    cell.setAttrNS(OFFICENS, "date-value", date_iso)

    if doc:
        style_name: str = ensure_date_style_exists(doc)
        cell.setAttrNS(TABLENS, "style-name", style_name)


def _set_date_value(cell: table.TableCell, value: date, doc: Any | None) -> None:
    """Set a date value in a cell.

    :param cell: ODS table cell
    :type cell: table.TableCell
    :param value: Date value to set
    :type value: date
    :param doc: Optional ODS document for date style
    :type doc: Any | None
    """
    date_iso: str = value.strftime("%Y-%m-%d")

    p: text.P = text.P(text="")
    cell.appendChild(p)

    cell.setAttrNS(OFFICENS, "value-type", "date")
    cell.setAttrNS(OFFICENS, "date-value", date_iso)

    if doc:
        style_name: str = ensure_date_style_exists(doc)
        cell.setAttrNS(TABLENS, "style-name", style_name)


def _set_numeric_value(cell: table.TableCell, value: int | float) -> None:
    """Set a numeric value in a cell.

    :param cell: ODS table cell
    :type cell: table.TableCell
    :param value: Numeric value to set
    :type value: int | float
    """
    p: text.P = text.P(text=str(value))
    cell.appendChild(p)

    cell.setAttrNS(OFFICENS, "value-type", "float")
    cell.setAttrNS(OFFICENS, "value", str(value))


def _set_formula_value(cell: table.TableCell, value: str) -> None:
    """Set a formula value in a cell.

    :param cell: ODS table cell
    :type cell: table.TableCell
    :param value: Formula string (starting with =)
    :type value: str
    """
    p: text.P = text.P(text="")
    cell.appendChild(p)

    # Convert commas to dots in formula (LibreOffice requires dots as decimal separator)
    formula: str = value.replace(",", ".")

    cell.setAttrNS(TABLENS, "formula", f"of:{formula}")
    cell.setAttrNS(OFFICENS, "value-type", "float")


def _set_string_value(cell: table.TableCell, value: str) -> None:
    """Set a string value in a cell, attempting to parse as numeric first.

    :param cell: ODS table cell
    :type cell: table.TableCell
    :param value: String value to set
    :type value: str
    """
    # Try to parse as numeric value
    try:
        numeric_value: float = float(value.replace(",", "."))

        p: text.P = text.P(text=str(numeric_value))
        cell.appendChild(p)

        cell.setAttrNS(OFFICENS, "value-type", "float")
        cell.setAttrNS(OFFICENS, "value", str(numeric_value))
    except (ValueError, AttributeError):
        # Not a number - treat as string
        p = text.P(text=str(value))
        cell.appendChild(p)

        cell.setAttrNS(OFFICENS, "value-type", "string")


def set_cell_value(
    cell: table.TableCell, value: Any, doc: OpenDocument | None = None
) -> None:
    """Set value in an ODS cell while preserving its style.

    :param cell: ODS table cell
    :type cell: table.TableCell
    :param value: Value to set (can be string, number, date, or datetime)
    :type value: Any
    :param doc: Optional ODS document (required for date values to apply proper formatting)
    :type doc: OpenDocument | None
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
        _set_datetime_value(cell, value, doc)
    elif isinstance(value, date):
        _set_date_value(cell, value, doc)
    elif isinstance(value, (int, float)):
        _set_numeric_value(cell, value)
    elif isinstance(value, str):
        if value.startswith("="):
            _set_formula_value(cell, value)
        else:
            _set_string_value(cell, value)
    else:
        # Fallback: treat as string
        p: text.P = text.P(text=str(value))
        cell.appendChild(p)
        cell.setAttrNS(OFFICENS, "value-type", "string")


def clear_cell_completely(cell: table.TableCell) -> None:
    """Clear all content and value attributes from an ODS cell.

    This removes:
    - All child nodes (text content)
    - All office: value attributes (value, value-type, currency, etc.)
    - Table formulas
    - LibreOffice Calc extension attributes

    :param cell: ODS table cell to clear
    :type cell: table.TableCell
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
