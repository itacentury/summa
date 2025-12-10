"""
AI Bill Analyzer - Extract and organize bill data from PDFs into ODS spreadsheets

This tool uses Claude AI to extract structured data from bill PDFs and automatically
inserts them into an ODS spreadsheet with proper formatting preservation.
"""

import json
from datetime import datetime
from typing import Any

import requests

from bill_analyzer.bill_inserter import process_multiple_bills
from bill_analyzer.claude_api import analyze_bill_pdf
from bill_analyzer.config import PAPERLESS_TOKEN, PAPERLESS_URL
from bill_analyzer.json_utils import parse_json_from_markdown
from bill_analyzer.paperless_api import upload_to_paperless
from bill_analyzer.ui import select_pdf_files
from bill_analyzer.validators import validate_bill_total


def convert_date_to_iso8601(date_str: str | None) -> str | None:
    """Convert various date formats to ISO 8601 datetime format.

    Supports: YYYY-MM-DD, DD.MM.YYYY, DD.MM.YY, YYYYMMDD

    :param date_str: Date string in various formats
    :type date_str: str | None
    :return: ISO 8601 datetime string (YYYY-MM-DDThh:mm:ssZ) or None
    :rtype: str | None
    """
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
        print(f"  ⚠ Warning: Could not parse date '{date_str}'")
        return None


def upload_bill_to_paperless(pdf: str, bill_data: dict[str, Any]) -> None:
    """Upload a bill PDF to Paperless-ngx with metadata.

    :param pdf: Path to the PDF file
    :type pdf: str
    :param bill_data: Extracted bill data containing store, date, total, etc.
    :type bill_data: dict[str, Any]
    """
    if not (PAPERLESS_TOKEN and PAPERLESS_URL):
        return

    try:
        print("\n📤 Uploading to Paperless-ngx...")

        # Create a title from store and date
        title: str = f"{bill_data.get('store', 'Bill')}"

        # Get total price for custom field
        total_price: float = bill_data.get("total", 0.0)

        # Format date for Paperless (requires ISO 8601 format)
        created_datetime: str | None = convert_date_to_iso8601(bill_data.get("date"))

        # Upload the PDF
        task_uuid: str = upload_to_paperless(
            pdf_path=pdf,
            token=PAPERLESS_TOKEN,
            paperless_url=PAPERLESS_URL,
            title=title,
            created=created_datetime,
            custom_fields={1: total_price},
        )

        print(f"✓ Uploaded successfully (Task UUID: {task_uuid})")

    except requests.HTTPError as e:
        print(f"⚠ Paperless upload failed: {e}")
        # Print detailed error response from Paperless
        if hasattr(e, "response") and e.response is not None:
            try:
                error_details = e.response.json()
                print(f"  Error details: {error_details}")
            except (ValueError, KeyError):
                print(f"  Response text: {e.response.text}")
    except requests.RequestException as e:
        print(f"⚠ Paperless upload failed: {e}")
    except FileNotFoundError as e:
        print(f"⚠ PDF file not found: {e}")


def validate_and_print_bill(bill_data: dict[str, Any]) -> bool:
    """Validate bill total and print validation results.

    :param bill_data: Extracted bill data to validate
    :type bill_data: dict[str, Any]
    :return: True if validation passed, False otherwise
    :rtype: bool
    """
    try:
        validation_result: dict[str, bool | float | str] = validate_bill_total(
            bill_data
        )
        print(f"\n{validation_result['message']}")

        if not validation_result["valid"]:
            print(f"  Calculated sum: {validation_result['calculated_sum']}€")
            print(f"  Declared total: {validation_result['declared_total']}€")
            print(f"  Difference: {validation_result['difference']}€")
            print("  ⚠ Warning: Price validation failed - data may be incorrect!")

        return bool(validation_result["valid"])
    except (KeyError, ValueError) as e:
        print(f"⚠ Validation error: {e}")
        return False


def main() -> None:
    """Main application entry point."""
    print("=== AI BILL ANALYZER ===\n")

    # Select PDF files
    pdfs: tuple[str, ...] = select_pdf_files()
    if not pdfs:
        print("No files selected.")
        return

    # Analyze all PDFs and collect bill data
    bills_data: list[dict[str, Any]] = []
    for pdf in pdfs:
        print(f"\nAnalyzing: {pdf}")

        # Analyze PDF with Claude
        response: str = analyze_bill_pdf(pdf)

        # Parse JSON from response
        bill_data: dict[str, Any] = parse_json_from_markdown(response)
        print(json.dumps(bill_data, indent=2, ensure_ascii=False))

        # Validate that sum of item prices equals total
        is_valid = validate_and_print_bill(bill_data)

        # Only process bill further if validation passed
        if is_valid:
            # Upload to Paperless-ngx if enabled
            upload_bill_to_paperless(pdf, bill_data)
            # Add to list for ODS insertion
            bills_data.append(bill_data)
        else:
            print(
                "  ⚠ Skipping Paperless upload and ODS insertion due to validation failure"
            )

    # Insert all bills into ODS in a single batch operation
    if bills_data:
        print("\n" + "=" * 60)
        print(f"Inserting {len(bills_data)} bill(s) into ODS file...")
        print("=" * 60)
        process_multiple_bills(bills_data)


if __name__ == "__main__":
    main()
