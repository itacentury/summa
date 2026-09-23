"""Environment-backed configuration for the single-password login gate.

Every value is read from ``os.environ`` inside its accessor rather than at
import time. That keeps the module import-order independent and lets tests flip
the gate on with ``monkeypatch.setenv`` — the same lazy-read shape
:mod:`summa.ai` uses for its own feature switch.
"""

import os
from typing import Final

AUTH_ENABLED_ENV: Final[str] = "AUTH_ENABLED"
PASSWORD_HASH_ENV: Final[str] = "AUTH_PASSWORD_HASH"
SESSION_SECRET_ENV: Final[str] = "SESSION_SECRET"
SESSION_DAYS_ENV: Final[str] = "SESSION_DAYS"
COOKIE_SECURE_ENV: Final[str] = "COOKIE_SECURE"
COOKIE_SAMESITE_ENV: Final[str] = "COOKIE_SAMESITE"
CORS_ORIGINS_ENV: Final[str] = "CORS_ALLOWED_ORIGINS"
BENCHMARK_SYMBOL_ENV: Final[str] = "BENCHMARK_SYMBOL"

# Spellings that read as "off" for a boolean switch. Matches summa.ai so the
# whole app answers to the same vocabulary.
_FALSY: Final[frozenset[str]] = frozenset({"", "0", "false", "no", "off"})

DEFAULT_SESSION_DAYS: Final[int] = 30

# Ten years is past any real "stay signed in" intent, so a larger number is a
# typo rather than a policy — and one big enough to overflow timedelta() would
# take create_app() down with it.
MAX_SESSION_DAYS: Final[int] = 3650

# Browsers reject anything else, and SameSite=None without Secure is dropped
# outright — an unrecognized value would silently break login rather than fail
# loudly, so it falls back to the default.
_VALID_SAMESITE: Final[frozenset[str]] = frozenset({"lax", "strict", "none"})
DEFAULT_COOKIE_SAMESITE: Final[str] = "Lax"

# iShares Core MSCI World UCITS ETF, Xetra -- the EUR-quoted MSCI World.
DEFAULT_BENCHMARK_SYMBOL: Final[str] = "EUNL.DE"


def _env_bool(name: str, default: bool) -> bool:
    """Read a boolean environment variable, treating unset as ``default``."""
    raw_value: str | None = os.environ.get(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() not in _FALSY


def auth_enabled() -> bool:
    """Return whether the password gate is active for this deployment."""
    return _env_bool(AUTH_ENABLED_ENV, False)


def password_hash() -> str:
    """Return the configured password hash, or an empty string when unset."""
    return os.environ.get(PASSWORD_HASH_ENV, "").strip()


def session_secret() -> str:
    """Return the key used to sign session cookies, or an empty string when unset."""
    return os.environ.get(SESSION_SECRET_ENV, "").strip()


def session_days() -> int:
    """Return the "stay signed in" lifetime in days, falling back to the default.

    Anything unparseable or outside 1..``MAX_SESSION_DAYS`` yields
    ``DEFAULT_SESSION_DAYS``.
    """
    raw_value: str = os.environ.get(SESSION_DAYS_ENV, "").strip()
    try:
        days: int = int(raw_value)
    except ValueError:
        return DEFAULT_SESSION_DAYS
    return days if 0 < days <= MAX_SESSION_DAYS else DEFAULT_SESSION_DAYS


def cookie_secure() -> bool:
    """Return whether the session cookie carries the ``Secure`` flag."""
    return _env_bool(COOKIE_SECURE_ENV, True)


def cookie_samesite() -> str:
    """Return the ``SameSite`` value for the session cookie."""
    raw_value: str = os.environ.get(COOKIE_SAMESITE_ENV, "").strip().lower()
    if raw_value not in _VALID_SAMESITE:
        return DEFAULT_COOKIE_SAMESITE
    return raw_value.capitalize()


def cors_origins() -> str | list[str]:
    """Resolve the CORS allowlist from ``CORS_ALLOWED_ORIGINS``.

    Empty/unset -> no cross-origin access (the PWA is same-origin). The literal
    '*' is an explicit opt-in for native mobile clients; otherwise a
    comma-separated origin allowlist.
    """
    raw_value: str = os.environ.get(CORS_ORIGINS_ENV, "").strip()
    if not raw_value:
        return []
    if raw_value == "*":
        return "*"
    return [origin.strip() for origin in raw_value.split(",") if origin.strip()]


def benchmark_symbol() -> str:
    """Return the ticker whose closes are the benchmark line.

    Both the chart and ``scripts/fetch_benchmark.py`` resolve the symbol here, so
    a deployment that follows a different index switches the two together and a
    one-off fetch of some other ticker cannot take the chart over.
    """
    raw_value: str = os.environ.get(BENCHMARK_SYMBOL_ENV, "").strip()
    return raw_value or DEFAULT_BENCHMARK_SYMBOL
