"""
Claude API Examples - Sending Requests and Processing Responses
"""

import base64
import json
import os
import re
import shutil
import tkinter as tk
from datetime import datetime as dt
from tkinter import filedialog

import anthropic
import dateutil.parser as dparser
from odf import opendocument, table, text
from odf.namespaces import OFFICENS
from odf.opendocument import load

ODS_FILE = "/home/juli/Downloads/Alltags-Ausgaben.ods"

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))


def parse_json_from_markdown(text):
    # Try to extract JSON from markdown code block (```json ... ``` or ``` ... ```)
    json_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)

    if json_match:
        json_str = json_match.group(1)
    else:
        # If no markdown block found, assume the entire text is JSON
        json_str = text

    # Parse the JSON string
    return json.loads(json_str.strip())


def pdf_analysis(pdf):
    with open(pdf, "rb") as pdf_file:
        pdf_data = base64.standard_b64encode(pdf_file.read()).decode("utf-8")

    message = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=2048,
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
                    {
                        "type": "text",
                        "text": """Bitte extrahiere folgende Daten aus der Rechnung:
                        1. Name des Supermarkts, ohne Gewerbeform, also nur 'REWE' oder 'Edeka'
                        2. Datum ohne Uhrzeit
                        3. Alle Artikel inklusive Preis
                        4. Gesamtpreis

                        Gebe mir die Daten im JSON-Format zurück, mit folgenden Namen und Datentypen:
                        'store' (str), 'date' (str), 'item' (list[dict[str, str | float]]), 'total' (float)""",
                    },
                ],
            }
        ],
    )

    response = message.content[0].text
    return response


def ask_pdfs():
    root = tk.Tk()
    root.withdraw()

    file_paths = filedialog.askopenfilenames(
        parent=root,
        title="Select Bills to Analyze",
        filetypes=[("PDF files", "*.pdf")],
        initialdir=os.path.expanduser("~/Downloads"),
    )

    return file_paths


def get_cell_value(cell):
    """Extract value from ODS cell"""
    # Try to get the value attribute
    value_attr = cell.getAttrNS(OFFICENS, "value")
    if value_attr:
        return float(value_attr)

    date_value_attr = cell.getAttrNS(OFFICENS, "date-value")
    if date_value_attr:
        return date_value_attr

    string_value_attr = cell.getAttrNS(OFFICENS, "string-value")
    if string_value_attr:
        return string_value_attr

    # Fallback: get text content
    text_content = []
    for p_element in cell.getElementsByType(text.P):
        text_content.append(str(p_element))
    return "".join(text_content) if text_content else ""


def set_cell_value(cell, value):
    """Set value in ODS cell while preserving style"""
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


def read_ods(data):
    date_str = data["date"]
    date_parsed = dparser.parse(date_str, dayfirst=True)
    month = date_parsed.strftime("%b")
    year = date_parsed.strftime("%y")
    sheet_name = f"{month} {year}"

    # Create backup before writing
    backup_file = ODS_FILE.replace(
        ".ods", f"_backup_{dt.now().strftime('%Y%m%d_%H%M%S')}.ods"
    )
    print(f"Creating backup: {backup_file}")
    shutil.copy2(ODS_FILE, backup_file)

    try:
        # Load ODS document
        print(f"Loading ODS file...")
        doc = load(ODS_FILE)

        # Find the correct sheet
        sheets = doc.spreadsheet.getElementsByType(table.Table)
        target_sheet = None
        for sheet in sheets:
            from odf.namespaces import TABLENS

            sheet_name_attr = sheet.getAttrNS(TABLENS, "name")
            if sheet_name_attr == sheet_name:
                target_sheet = sheet
                break

        if not target_sheet:
            print(f"⚠ Sheet '{sheet_name}' not found")
            return

        # Find the row with matching date
        rows = target_sheet.getElementsByType(table.TableRow)
        target_row_idx = None

        for idx, row in enumerate(rows):
            cells = row.getElementsByType(table.TableCell)
            if len(cells) > 1:
                cell_value = get_cell_value(cells[1])
                # Try to parse as date
                try:
                    if isinstance(cell_value, str) and cell_value.startswith("20"):
                        # ISO date format
                        cell_date = dparser.parse(cell_value).date()
                        if cell_date == date_parsed.date():
                            target_row_idx = idx
                            break
                except:
                    pass

        if target_row_idx is None:
            print(f"⚠ No row found for date {date_parsed.date()}")
            return

        target_row = rows[target_row_idx]
        cells = target_row.getElementsByType(table.TableCell)

        # Fill the first row with store, first item, and first price
        first_item = data["item"][0]
        set_cell_value(cells[2], data["store"])
        set_cell_value(cells[3], first_item["name"])
        set_cell_value(cells[4], first_item["price"])

        # Insert new rows for remaining items
        for item in data["item"][1:]:
            from odf.namespaces import TABLENS

            new_row = table.TableRow()

            # Copy style from target row
            row_style = target_row.getAttrNS(TABLENS, "style-name")
            if row_style:
                new_row.setAttrNS(TABLENS, "style-name", row_style)

            # Create cells (copy structure from target row)
            for col_idx in range(len(cells)):
                new_cell = table.TableCell()

                # Copy style from original cell
                cell_style = cells[col_idx].getAttrNS(TABLENS, "style-name")
                if cell_style:
                    new_cell.setAttrNS(TABLENS, "style-name", cell_style)

                # Set values for item and price columns
                if col_idx == 3:
                    set_cell_value(new_cell, item["name"])
                elif col_idx == 4:
                    set_cell_value(new_cell, item["price"])
                else:
                    # Empty cell with preserved style
                    new_cell.appendChild(text.P(text=""))

                new_row.appendChild(new_cell)

            # Insert after target row
            target_sheet.insertBefore(new_row, rows[target_row_idx + 1])

        # Add final row with total
        from odf.namespaces import TABLENS

        total_row = table.TableRow()
        row_style = target_row.getAttrNS(TABLENS, "style-name")
        if row_style:
            total_row.setAttrNS(TABLENS, "style-name", row_style)

        for col_idx in range(len(cells)):
            new_cell = table.TableCell()
            cell_style = cells[col_idx].getAttrNS(TABLENS, "style-name")
            if cell_style:
                new_cell.setAttrNS(TABLENS, "style-name", cell_style)

            if col_idx == 4:
                set_cell_value(new_cell, data["total"])
            else:
                new_cell.appendChild(text.P(text=""))

            total_row.appendChild(new_cell)

        target_sheet.insertBefore(total_row, rows[target_row_idx + 1])

        print(f"✓ Inserted {len(data['item'])} items + total for {data['store']}")

        # Save the document
        print("Saving document...")
        doc.save(ODS_FILE)
        print(f"✓ Successfully saved to {ODS_FILE}")

    except Exception as e:
        print(f"✗ Error: {e}")
        print(f"Restoring from backup...")
        shutil.copy2(backup_file, ODS_FILE)
        print(f"✓ Restored from backup")
        raise


def main():
    print("=== AI BILL ANALYZER ===\n")

    pdfs = ask_pdfs()
    for pdf in pdfs:
        response = pdf_analysis(pdf)
        data = parse_json_from_markdown(response)
        print(json.dumps(data, indent=2, ensure_ascii=False))

        read_ods(data)


if __name__ == "__main__":
    main()
