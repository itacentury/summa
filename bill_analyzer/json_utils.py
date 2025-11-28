"""
JSON parsing utilities
"""

import json
import re
from typing import Any


def parse_json_from_markdown(text: str) -> dict[str, Any]:
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
