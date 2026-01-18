"""
Configuration constants for the AI Bill Analyzer
"""

import os
from typing import Final

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv(".env.bill_analyzer")

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
# EXTRACTION PROMPT
# ==============================================================================

EXTRACTION_PROMPT: Final[
    str
] = """Bitte extrahiere folgende Daten aus der Rechnung:
1. Name des Supermarkts, ohne Gewerbeform o.ä., also nur 'REWE' oder 'Edeka'.
2. Die Kategorie des Einkaufs. Zum Beispiel 'Lebensmittel', 'Restaurant' oder 'Elektronik'.
3. Datum ohne Uhrzeit im ISO-8601 Format.
4. Gesamtpreis.
5. Alle Artikel inklusive Preis, Artikel in korrekter deutschen Groß- und Kleinschreibung.

Wenn der gleiche Artikel mehrfach gekauft wurde, dann schreibe als Preis für den Artikel den zusammengerechneten Preis
und füge auch die Anzahl vor dem Artikelnamen hinzu (z.B. '4x Semmel'), außer bei Pfand.
Wenn ein Artikel Pfand hat, addiere den dazugehörigen Pfand zum Preis des Artikels.
Wenn ich bei einem Einkauf Pfand zurückgebe, behandle dies als Negativzahl und fasse jeden zurückgegebenen Pfand unter einem einzigen Eintrag 'Pfand' zusammen.
Schreibe das Gewicht bei zum Beispiel Gemüse oder Obst, hinten an den Namen des dazugehörigen Gemüse oder Obstes.

Gebe mir die Daten im JSON-Format zurück, mit folgenden Namen und Datentypen:
'store' (str), 'category' (str), 'date' (str), 'items' (list[dict[str, str | float]]), 'total' (float).
Die Keys für das 'items' dictionary sollen 'item_name' und 'item_price' heißen.
Die Values von 'item_name' sind strings und die values von 'item_price' sind floats."""
