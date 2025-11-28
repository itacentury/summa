"""
Claude API integration for PDF bill analysis
"""

import base64
import os

import anthropic

from .config import CLAUDE_MAX_TOKENS, CLAUDE_MODEL, EXTRACTION_PROMPT

# Initialize Anthropic API client
client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))


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
