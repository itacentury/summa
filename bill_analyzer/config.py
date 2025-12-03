"""
Configuration constants for the AI Bill Analyzer
"""

import os
from pathlib import Path
from typing import Final

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv(".env.bill_analyzer")

# ==============================================================================
# FILE PATHS
# ==============================================================================

ODS_FILE: Final[str] = str(
    Path.home() / "SeaDrive" / "My Libraries" / "Dokumente" / "personal_expenses.ods"
)


# ==============================================================================
# CLAUDE API CONFIGURATION
# ==============================================================================

# CLAUDE_MODEL: Final[str] = "claude-sonnet-4-5-20250929"
CLAUDE_MODEL: Final[str] = "claude-opus-4-5-20251101"
CLAUDE_MAX_TOKENS: Final[int] = 2048


# ==============================================================================
# PAPERLESS-NGX API CONFIGURATION
# ==============================================================================

# Paperless-ngx instance URL (from environment or default)
PAPERLESS_URL: Final[str | None] = os.environ.get("PAPERLESS_URL")

# Paperless-ngx API token (from environment)
PAPERLESS_TOKEN: Final[str | None] = os.environ.get("PAPERLESS_API_TOKEN")


# ==============================================================================
# ODS COLUMN INDICES
# ==============================================================================

COL_DATE: Final[int] = 1
COL_STORE: Final[int] = 2
COL_ITEM: Final[int] = 3
COL_PRICE: Final[int] = 4
COL_TOTAL: Final[int] = 5


# ==============================================================================
# EXTRACTION PROMPT
# ==============================================================================

EXTRACTION_PROMPT: Final[
    str
] = """Bitte extrahiere folgende Daten aus der Rechnung:
1. Name des Supermarkts, ohne Gewerbeform o.ä., also nur 'REWE' oder 'Edeka'.
2. Datum ohne Uhrzeit.
3. Alle Artikel inklusive Preis, Artikel in korrekter deutschen Groß- und Kleinschreibung.
4. Gesamtpreis.

Wenn der gleiche Artikel mehrfach gekauft wurde, dann schreibe als Preis für den Artikel: Anzahl * Einzelpreis (z.B. '=4*0,59')
und füge auch die Anzahl vor dem Artikelnamen hinzu (z.B. '4x Semmel'), außer bei Pfand.
Wenn ein Artikel Pfand hat, dann schreibe als Preis für den Artikel: Artikelpreis + Pfand (z.B. '=0,89+0,08' oder '=3*(0,89+0,08)').
Schreibe das Gewicht bei zum Beispiel Gemüse oder Obst, hinten an den Namen des dazugehörigen Gemüse oder Obstes.

Gebe mir die Daten im JSON-Format zurück, mit folgenden Namen und Datentypen:
'store' (str), 'date' (str), 'items' (list[dict[str, str]]), 'total' (float)."""


# ==============================================================================
# ODS NAMESPACES
# ==============================================================================

CALCEXT_NS: Final[str] = (
    "urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"
)


# ==============================================================================
# ODS ATTRIBUTE LISTS FOR CELL CLEARING
# ==============================================================================

OFFICE_ATTRS_TO_CLEAR: Final[list[str]] = [
    "value",
    "date-value",
    "time-value",
    "boolean-value",
    "string-value",
    "value-type",
    "currency",
]

TABLE_ATTRS_TO_CLEAR: Final[list[str]] = ["formula"]

CALCEXT_ATTRS_TO_CLEAR: Final[list[str]] = ["value-type"]
