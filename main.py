"""
AI Bill Analyzer - Extract and organize bill data from PDFs into ODS spreadsheets

This tool uses Claude AI to extract structured data from bill PDFs and automatically
inserts them into an ODS spreadsheet with proper formatting preservation.
"""

import json

from bill_analyzer.bill_inserter import insert_bill_into_ods
from bill_analyzer.claude_api import analyze_bill_pdf
from bill_analyzer.json_utils import parse_json_from_markdown
from bill_analyzer.ui import select_pdf_files


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
