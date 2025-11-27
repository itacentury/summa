"""
AI Bill Analyzer - Extract and organize bill data from PDFs into ODS spreadsheets

This tool uses Claude AI to extract structured data from bill PDFs and automatically
inserts them into an ODS spreadsheet with proper formatting preservation.
"""

import base64
import json
import os
import re
import shutil
import tkinter as tk
from datetime import datetime as dt
from tkinter import filedialog
from typing import Any, Dict, List, Optional, Tuple

import anthropic
import dateutil.parser as dparser
from odf import table, text
from odf.namespaces import OFFICENS, TABLENS
from odf.opendocument import load

# ==============================================================================
# CONSTANTS AND CONFIGURATION
# ==============================================================================

# File paths
ODS_FILE = "/home/juli/Downloads/Alltags-Ausgaben.ods"

# Claude API configuration
CLAUDE_MODEL = "claude-sonnet-4-5-20250929"
CLAUDE_MAX_TOKENS = 2048

# ODS column indices
COL_DATE = 1
COL_STORE = 2
COL_ITEM = 3
COL_PRICE = 4
COL_TOTAL = 5

# Extraction prompt template
EXTRACTION_PROMPT = """Bitte extrahiere folgende Daten aus der Rechnung:
1. Name des Supermarkts, ohne Gewerbeform, also nur 'REWE' oder 'Edeka'.
2. Datum ohne Uhrzeit.
3. Alle Artikel inklusive Preis, ein Artikel pro Zeile, Artikel in korrekter deutschen Groß- und Kleinschreibung.
4. Gesamtpreis.

Gebe mir die Daten im JSON-Format zurück, mit folgenden Namen und Datentypen:
'store' (str), 'date' (str), 'item' (list[dict[str, str | float]]), 'total' (float)."""

# Namespaces for ODS attribute removal
CALCEXT_NS = "urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"

# Attributes to remove when clearing cells
OFFICE_ATTRS_TO_CLEAR = [
    "value",
    "date-value",
    "time-value",
    "boolean-value",
    "string-value",
    "value-type",
    "currency",
]
TABLE_ATTRS_TO_CLEAR = ["formula"]
CALCEXT_ATTRS_TO_CLEAR = ["value-type"]


# ==============================================================================
# ANTHROPIC API CLIENT
# ==============================================================================

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))


# ==============================================================================
# JSON PARSING
# ==============================================================================


def parse_json_from_markdown(text: str) -> Dict[str, Any]:
    """
    Extract and parse JSON from a markdown code block or plain JSON string.

    Handles both formats:
    - Markdown: ```json\n{...}\n```
    - Plain JSON: {...}

    Args:
        text: Text containing JSON, possibly wrapped in markdown code blocks

    Returns:
        Parsed JSON as a dictionary

    Raises:
        json.JSONDecodeError: If the JSON is malformed
    """
    # Try to extract JSON from markdown code block
    json_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)

    if json_match:
        json_str = json_match.group(1)
    else:
        # If no markdown block found, assume the entire text is JSON
        json_str = text

    return json.loads(json_str.strip())


# ==============================================================================
# PDF ANALYSIS WITH CLAUDE
# ==============================================================================


def analyze_bill_pdf(pdf_path: str) -> str:
    """
    Analyze a bill PDF using Claude AI to extract structured data.

    Args:
        pdf_path: Path to the PDF file

    Returns:
        Raw response text from Claude (contains JSON in markdown format)

    Raises:
        FileNotFoundError: If PDF file doesn't exist
        anthropic.APIError: If Claude API call fails
    """
    with open(pdf_path, "rb") as pdf_file:
        pdf_data = base64.standard_b64encode(pdf_file.read()).decode("utf-8")

    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=CLAUDE_MAX_TOKENS,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": pdf_data,
                        },
                    },
                    {"type": "text", "text": EXTRACTION_PROMPT},
                ],
            }
        ],
    )

    return message.content[0].text


# ==============================================================================
# USER INTERFACE
# ==============================================================================


def select_pdf_files() -> Tuple[str, ...]:
    """
    Open a file dialog to let the user select PDF files.

    Returns:
        Tuple of selected file paths (empty if cancelled)
    """
    root = tk.Tk()
    root.withdraw()

    file_paths = filedialog.askopenfilenames(
        parent=root,
        title="Select Bills to Analyze",
        filetypes=[("PDF files", "*.pdf")],
        initialdir=os.path.expanduser("~/Downloads"),
    )

    return file_paths


# ==============================================================================
# ODS CELL OPERATIONS
# ==============================================================================


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


def set_cell_value(cell: table.TableCell, value: Any) -> None:
    """
    Set value in an ODS cell while preserving its style.

    Args:
        cell: ODS table cell
        value: Value to set (will be converted to string)
    """
    # Clear existing content
    for child in list(cell.childNodes):
        cell.removeChild(child)

    # Add new text content
    p = text.P(text=str(value))
    cell.appendChild(p)

    # Set appropriate value type
    if isinstance(value, (int, float)):
        cell.setAttrNS(OFFICENS, "value-type", "float")
        cell.setAttrNS(OFFICENS, "value", str(value))
    else:
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
        cell.removeChild(child)

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


# ==============================================================================
# ODS ROW OPERATIONS
# ==============================================================================


def create_item_row(
    template_cells: List[table.TableCell],
    template_row_style: Optional[str],
    item_name: str,
    item_price: float,
    store_name: Optional[str] = None,
    total_price: Optional[float] = None,
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
    template_cells: List[table.TableCell], template_row_style: Optional[str]
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


# ==============================================================================
# ODS SHEET OPERATIONS
# ==============================================================================


def find_sheet_by_name(doc: Any, sheet_name: str) -> Optional[table.Table]:
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


def find_date_row(sheet: table.Table, target_date: dt.date) -> Optional[int]:
    """
    Find the row index containing a specific date.

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

        # Try to parse as date
        try:
            if isinstance(cell_value, str) and cell_value.startswith("20"):
                cell_date = dparser.parse(cell_value).date()
                if cell_date == target_date:
                    return idx
        except Exception:
            pass

    return None


def has_existing_data(cells: List[table.TableCell]) -> bool:
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


def save_existing_row_data(
    cells: List[table.TableCell],
) -> List[Tuple[Any, Optional[str]]]:
    """
    Save all data and styles from a row before modifying it.

    Args:
        cells: List of cells to save

    Returns:
        List of tuples (cell_value, cell_style)
    """
    row_data = []
    for cell in cells:
        cell_value = get_cell_value(cell)
        cell_style = cell.getAttrNS(TABLENS, "style-name")
        row_data.append((cell_value, cell_style))
    return row_data


def restore_row_as_new(
    old_row_data: List[Tuple[Any, Optional[str]]],
    template_row_style: Optional[str],
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


# ==============================================================================
# FILE OPERATIONS
# ==============================================================================


def create_backup(file_path: str) -> str:
    """
    Create a timestamped backup of a file.

    Args:
        file_path: Path to the file to backup

    Returns:
        Path to the backup file
    """
    timestamp = dt.now().strftime("%Y%m%d_%H%M%S")
    backup_path = file_path.replace(".ods", f"_backup_{timestamp}.ods")
    shutil.copy2(file_path, backup_path)
    print(f"Creating backup: {backup_path}")
    return backup_path


def restore_from_backup(backup_path: str, target_path: str) -> None:
    """
    Restore a file from its backup.

    Args:
        backup_path: Path to the backup file
        target_path: Path to restore to
    """
    print(f"Restoring from backup...")
    shutil.copy2(backup_path, target_path)
    print(f"✓ Restored from backup")


def remove_backup(backup_path: str) -> None:
    """
    Remove a backup file if it exists.

    Args:
        backup_path: Path to the backup file
    """
    if os.path.exists(backup_path):
        os.remove(backup_path)
        print(f"✓ Removed backup file")


# ==============================================================================
# MAIN ODS UPDATE LOGIC
# ==============================================================================


def insert_bill_into_ods(bill_data: Dict[str, Any]) -> None:
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

        # Find date row
        target_row_idx = find_date_row(target_sheet, date_parsed.date())
        if target_row_idx is None:
            print(f"⚠ No row found for date {date_parsed.date()}")
            return

        # Get row and cells
        rows = target_sheet.getElementsByType(table.TableRow)
        target_row = rows[target_row_idx]
        cells = target_row.getElementsByType(table.TableCell)
        row_style = target_row.getAttrNS(TABLENS, "style-name")

        # Save existing data
        old_data_exists = has_existing_data(cells)
        old_row_data = save_existing_row_data(cells) if old_data_exists else None

        # Overwrite date row with first item
        first_item = bill_data["item"][0]
        set_cell_value(cells[COL_STORE], bill_data["store"])
        set_cell_value(cells[COL_ITEM], first_item["name"])
        set_cell_value(cells[COL_PRICE], first_item["price"])

        # Clear total column
        for col_idx in range(COL_TOTAL, len(cells)):
            clear_cell_completely(cells[col_idx])

        # Add total if only one item
        if len(bill_data["item"]) == 1 and len(cells) > COL_TOTAL:
            set_cell_value(cells[COL_TOTAL], bill_data["total"])

        # Insert remaining items as new rows
        reference_row = (
            rows[target_row_idx + 1] if target_row_idx + 1 < len(rows) else None
        )

        remaining_items = bill_data["item"][1:]
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
            f"✓ Inserted {len(bill_data['item'])} items + total for {bill_data['store']}"
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


# ==============================================================================
# MAIN APPLICATION
# ==============================================================================


def main():
    """Main application entry point."""
    print("=== AI BILL ANALYZER ===\n")

    # Select PDF files
    pdfs = select_pdf_files()
    if not pdfs:
        print("No files selected.")
        return

    # Process each PDF
    for pdf in pdfs:
        print(f"\nProcessing: {pdf}")

        # Analyze PDF with Claude
        response = analyze_bill_pdf(pdf)

        # Parse JSON from response
        bill_data = parse_json_from_markdown(response)
        print(json.dumps(bill_data, indent=2, ensure_ascii=False))

        # Insert into ODS
        insert_bill_into_ods(bill_data)


if __name__ == "__main__":
    main()
