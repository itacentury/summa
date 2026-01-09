"""Module to extract bill items from ODS document."""

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final, TypedDict

import dateparser
from odf import text
from odf.namespaces import OFFICENS
from odf.opendocument import OpenDocument, load

if TYPE_CHECKING:
    from odf.table import Table, TableCell, TableRow
else:
    from odf import table

    TableRow = table.TableRow
    TableCell = table.TableCell
    Table = table.Table

ODS_FILE = Path.home() / "Downloads" / "expenses.ods"
COL_DATE: Final[int] = 1
COL_STORE: Final[int] = 2
COL_ITEM: Final[int] = 3
COL_PRICE: Final[int] = 4
COL_TOTAL: Final[int] = 5
COL_TOTAL_STRING: Final[int] = 6
COL_LENGTH_WITH_DATE: Final[int] = 9


class SingleItem(TypedDict):
    """Represents a single purchased item."""

    item_name: str
    item_price: str


class ItemEntry(TypedDict):
    """Represents a shopping entry with date, store, and purchased items."""

    date: str
    store: str
    total: str
    items: list[SingleItem]


def extract_all_items_per_date(rows: list[Any], idx: int) -> tuple[list[Any], int]:
    """Extracts and returns all rows corresponding to the same date."""
    extracted_rows: list[Any] = []
    new_idx: int = -1

    for i in range(idx, len(rows)):
        row: Any = rows[i]
        cells: list[Any] = row.getElementsByType(TableCell)

        if len(cells) <= COL_DATE:
            continue

        if get_cell_value(cells[COL_DATE]) and i != idx:
            new_idx = i
            break

        extracted_rows.append(row)

    return extracted_rows, new_idx


def extract_individual_items_inside_date(rows: list[Any]) -> list[ItemEntry]:
    """Extracts all stores inside the same date and returns them as a dictionary."""
    extracted_rows: list[Any] = []
    items: list[ItemEntry] = []
    date_str: str = ""

    for i, row in enumerate(rows):
        cells: list[Any] = row.getElementsByType(TableCell)
        if len(cells) <= COL_STORE:
            continue

        if i == 0:
            date_str = get_cell_value(cells[COL_DATE])

        is_new_store = (
            get_cell_value(cells[COL_STORE])
            and len(cells) >= COL_TOTAL_STRING + 1
            and i != 0
            and not get_cell_value(cells[COL_TOTAL_STRING]).startswith("Gesamtausgaben")
        )

        if is_new_store:
            # save previous entry, if exists
            if extracted_rows:
                item: ItemEntry = extract_item(extracted_rows, date_str)
                if is_valid_item_entry(item):
                    items.append(item)
            extracted_rows = []

        extracted_rows.append(row)

    # save last entry
    if extracted_rows:
        item = extract_item(extracted_rows, date_str)
        if is_valid_item_entry(item):
            items.append(item)

    return items


def is_valid_item_entry(item: ItemEntry) -> bool:
    """
    Check if an ItemEntry contains actual data.

    An entry is considered valid if it has a date, store name and at least one item.
    """
    return bool(item["date"] and item["store"] and item["total"] and item["items"])


def extract_item(rows: list[Any], date_str: str) -> ItemEntry:
    """Extracts items for a given store/date entry into a dictionary."""
    item: ItemEntry = {"date": date_str, "store": "", "total": "", "items": []}

    for row in rows:
        cells: list[Any] = row.getElementsByType(TableCell)

        if len(cells) <= COL_PRICE:
            continue

        store_val: str = get_cell_value(cells[COL_STORE])
        if store_val:
            item["store"] = store_val

        item_val: str = get_cell_value(cells[COL_ITEM])
        price_val: str = get_cell_value(cells[COL_PRICE])
        if item_val and price_val:
            if price_val in ["?", "??"]:
                price_val = "0"

            single_item: SingleItem = {"item_name": "", "item_price": ""}
            single_item["item_name"] = item_val
            single_item["item_price"] = price_val
            item["items"].append(single_item)

        if len(cells) <= COL_TOTAL:
            continue

        total_val: str = get_cell_value(cells[COL_TOTAL])
        if total_val:
            item["total"] = total_val

    return item


def save_json_file(data: list[ItemEntry], sheet_name: str) -> None:
    """Saves extracted items to a json file."""
    filename: str = f"expenses-{sheet_name}.json"
    print(f"  Saving extracted items to {filename}")
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=False)


def get_cell_value(cell: Any) -> str:
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


def convert_sheet_name(sheet_name: str) -> str:
    """Convert sheet name into numeric date."""
    parsed = dateparser.parse(sheet_name, date_formats=["%b %y"])
    if parsed is None:
        return ""

    return f"{str(parsed.year)}-{parsed.month:02d}"


def main() -> None:
    """Main entry point for the item extraction."""
    print("Loading ODS document...")
    doc: OpenDocument = load(ODS_FILE)
    sheets: list[Any] = doc.getElementsByType(Table)

    for _sheet_idx, sheet in enumerate(sheets):
        sheet_name: str = sheet.getAttribute("name")
        print(f"Analyzing sheet: {sheet_name}")

        rows: list[Any] = sheet.getElementsByType(TableRow)
        items_per_date: list[Any] = []
        all_items: list[ItemEntry] = []

        i = 2
        for _ in range(len(rows)):
            items_per_date, new_idx = extract_all_items_per_date(rows, i)

            all_items.extend(extract_individual_items_inside_date(items_per_date))

            if new_idx == -1:
                break

            if new_idx > i:
                i = new_idx
            else:
                i += 1

        save_json_file(all_items, convert_sheet_name(sheet_name))

        # for testing only check first two sheets
        # if _sheet_idx == 1:
        #     break


if __name__ == "__main__":
    main()
