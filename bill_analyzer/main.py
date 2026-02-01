"""
AI Bill Analyzer - Extract and organize bill data from PDFs into ODS spreadsheets

This tool uses Claude AI to extract structured data from bill PDFs and automatically
inserts them into an ODS spreadsheet with proper formatting preservation.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

from .claude_api import analyze_bill_pdf
from .config import EXPORT_JSON_PATH, PAPERLESS_TOKEN, PAPERLESS_TOTAL_ID, PAPERLESS_URL
from .paperless_api import upload_to_paperless
from .ui import select_pdf_files
from .utils import parse_json_from_markdown
from .validators import validate_bill_total


def convert_date_to_iso8601(date_str: str | None) -> str | None:
    """Convert various date formats to ISO 8601 datetime format."""
    if not date_str:
        return None

    try:
        # Try parsing as YYYY-MM-DD first
        if "-" in date_str:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
        # Try DD.MM.YYYY or DD.MM.YY format
        elif "." in date_str:
            parts = date_str.split(".")
            # Check if year is 2 or 4 digits
            if len(parts[2]) == 4:
                dt = datetime.strptime(date_str, "%d.%m.%Y")
            else:
                dt = datetime.strptime(date_str, "%d.%m.%y")
        else:
            dt = datetime.strptime(date_str, "%Y%m%d")

        # Format as ISO 8601 with midnight time
        return dt.strftime("%Y-%m-%dT00:00:00Z")
    except ValueError:
        print(f"  ⚠ Could not parse date '{date_str}'.")
        return None


def upload_bills_to_paperless(
    valid_pdfs: list[str], valid_bills: list[dict[str, Any]]
) -> tuple[int, int] | None:
    """Upload PDF bills to Paperless-ngx. Return (success, failed) counts or None if skipped."""
    if not (PAPERLESS_TOKEN and PAPERLESS_URL):
        print("\n⚠ Paperless not configured. Skipping upload.")
        return None

    if len(valid_pdfs) != len(valid_bills):
        print("\n⚠ PDFs and bills lists have different lengths. Skipping upload.")
        return None

    print("\n📤 Uploading to Paperless-ngx...")

    uploaded: int = 0
    failed: int = 0

    for pdf, bill in zip(valid_pdfs, valid_bills):
        try:
            title: str = f"{bill.get('store', 'Bill')}"
            total_price: float = bill.get("total", 0.0)
            created_datetime: str | None = convert_date_to_iso8601(bill.get("date"))

            task_uuid: str = upload_to_paperless(
                pdf_path=pdf,
                token=PAPERLESS_TOKEN,
                paperless_url=PAPERLESS_URL,
                title=title,
                created=created_datetime,
                custom_fields={PAPERLESS_TOTAL_ID: total_price},
            )

            print(f"  ✓ Uploaded successfully. (Task: {task_uuid})")
            uploaded += 1

        except requests.HTTPError as e:
            print(f"  ⚠ Upload failed: {e}")
            failed += 1
            if hasattr(e, "response") and e.response is not None:
                try:
                    error_details = e.response.json()
                    print(f"    Details: {error_details}")
                except (ValueError, KeyError):
                    print(f"    Response: {e.response.text}")
        except requests.RequestException as e:
            print(f"  ⚠ Upload failed: {e}")
            failed += 1
        except FileNotFoundError as e:
            print(f"  ⚠ File not found: {e}")
            failed += 1

    return (uploaded, failed)


def validate_bill(bill_data: dict[str, Any]) -> dict[str, bool | float | str] | None:
    """Validate bill total. Return None on error, otherwise the result object."""
    result: dict[str, bool | float | str] | None = validate_bill_total(bill_data)

    if result is None:
        print("  ⚠ Validation failed.")
        return None

    return result


def print_bill(validation_result: dict[str, bool | float | str]) -> None:
    """Print bill validation result."""
    print(f"  {validation_result['message']}")

    if validation_result["valid"]:
        return

    print(f"    Calculated: {validation_result['calculated_sum']}€")
    print(f"    Declared:   {validation_result['declared_total']}€")
    print(f"    Difference: {validation_result['difference']}€")
    print("  ⚠ Price mismatch - data may be incorrect.")


def save_bills_to_json(data: list[dict[str, Any]]) -> None:
    """Save extracted items to a JSON file."""
    if not data:
        print("\n⚠ No valid bills. Skipping JSON export.")
        return

    filename: str = f"bills-{datetime.now().date()}.json"
    filepath: Path = EXPORT_JSON_PATH / filename
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=False)


def print_statistics(
    valid_count: int,
    total_count: int,
    failed_count: int,
    upload_result: tuple[int, int] | None,
) -> None:
    """Print summary statistics for processed bills."""
    print("\n" + "=" * 50)
    print("📊 STATISTICS")
    print("=" * 50)
    print(f"  ✓ Valid bills:   {valid_count} of {total_count}")
    print(f"  ✗ Failed bills:  {failed_count}")

    if upload_result is None:
        print("  ☁ Upload:        skipped")
    else:
        uploaded, upload_failed = upload_result
        print(f"  ☁ Uploaded:      {uploaded} of {valid_count}")
        if upload_failed > 0:
            print(f"  ⚠ Upload errors: {upload_failed}")


def main() -> None:
    """Run the bill analyzer."""
    print("=== AI BILL ANALYZER ===\n")

    pdfs: tuple[str, ...] = select_pdf_files()
    if not pdfs:
        print("⚠ No files selected.")
        return

    valid_bills: list[dict[str, Any]] = []
    valid_pdfs: list[str] = []
    failed_count: int = 0

    for pdf in pdfs:
        print(f"\n📄 Analyzing: {pdf}")

        response: str | None = analyze_bill_pdf(pdf)

        if response is None:
            failed_count += 1
            continue

        bill_data: dict[str, Any] = parse_json_from_markdown(response)
        print(json.dumps(bill_data, indent=2, ensure_ascii=False))

        result: dict[str, bool | float | str] | None = validate_bill(bill_data)

        if result is None:
            failed_count += 1
            continue

        print_bill(result)

        if not result["valid"]:
            failed_count += 1
            continue

        valid_bills.append(bill_data)
        valid_pdfs.append(pdf)

    save_bills_to_json(valid_bills)
    upload_result: tuple[int, int] | None = upload_bills_to_paperless(
        valid_pdfs, valid_bills
    )
    print_statistics(len(valid_bills), len(pdfs), failed_count, upload_result)


if __name__ == "__main__":
    main()
