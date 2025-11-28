"""
ODS date style management functions
"""

from typing import Any

from odf import number, style
from odf.namespaces import STYLENS


def ensure_date_style_exists(doc: Any) -> str:
    """
    Ensure a date-only style exists in the document and return its name.

    This creates a number-style that formats dates as DD.MM.YY without time.

    Args:
        doc: ODS document object

    Returns:
        Name of the date style to use
    """
    style_name = "date-short-year-style"
    number_style_name = "N_DATE_SHORT_YEAR"

    # Check if style already exists
    if hasattr(doc, "styles"):
        for existing_style in doc.styles.getElementsByType(style.Style):
            if existing_style.getAttribute("name") == style_name:
                return style_name

    # Create the number:date-style
    date_style = number.DateStyle(name=number_style_name)

    # Add day (DD)
    date_style.addElement(number.Day(style="long"))

    # Add separator
    date_style.addElement(number.Text(text="."))

    # Add month (MM)
    date_style.addElement(number.Month(style="long"))

    # Add separator
    date_style.addElement(number.Text(text="."))

    # Add year (YY)
    date_style.addElement(number.Year(style="short"))

    # Add the number style to the document
    doc.styles.addElement(date_style)

    # Create a cell style that uses this number style
    cell_style = style.Style(name=style_name, family="table-cell")
    cell_style.setAttrNS(STYLENS, "data-style-name", number_style_name)

    # Add the cell style to the document
    doc.styles.addElement(cell_style)

    return style_name
