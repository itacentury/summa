"""Tests for the session configuration accessors in :mod:`summa.config`."""

import pytest
from flask.testing import FlaskClient

from summa import config
from tests.conftest import BuildClient

# Every SameSite spelling an operator might set, and what it normalizes to.
# The last three are the silent fallback: an unrecognized value must not reach
# Flask, which would raise on it and take the whole app down.
SAMESITE_VALUES: list[tuple[str, str]] = [
    ("lax", "Lax"),
    ("strict", "Strict"),
    ("none", "None"),
    ("STRICT", "Strict"),
    ("  Strict  ", "Strict"),
    ("", "Lax"),
    ("sometimes", "Lax"),
    ("true", "Lax"),
]

# COOKIE_SECURE is a boolean read through _env_bool(), which treats only these
# spellings as off — anything else set is on, so a typo fails safe.
SECURE_VALUES: list[tuple[str, bool]] = [
    ("0", False),
    ("false", False),
    ("FALSE", False),
    ("no", False),
    ("off", False),
    ("", False),
    ("1", True),
    ("true", True),
    ("yes", True),
]

# Every SESSION_DAYS spelling and the lifetime it resolves to. The accessor is
# total on purpose: the last two are the ones that matter, since a day count
# timedelta() cannot take would otherwise kill create_app() at boot.
SESSION_DAYS_VALUES: list[tuple[str, int]] = [
    ("7", 7),
    ("  7  ", 7),
    ("3650", config.MAX_SESSION_DAYS),
    ("0", config.DEFAULT_SESSION_DAYS),
    ("-5", config.DEFAULT_SESSION_DAYS),
    ("abc", config.DEFAULT_SESSION_DAYS),
    ("", config.DEFAULT_SESSION_DAYS),
    ("3651", config.DEFAULT_SESSION_DAYS),
    ("99999999999", config.DEFAULT_SESSION_DAYS),
]


@pytest.mark.parametrize(("configured", "expected"), SAMESITE_VALUES)
def test_cookie_samesite_normalizes_the_configured_value(
    monkeypatch: pytest.MonkeyPatch, configured: str, expected: str
) -> None:
    """Case and padding are the operator's business; Flask wants one spelling."""
    monkeypatch.setenv(config.COOKIE_SAMESITE_ENV, configured)

    assert config.cookie_samesite() == expected


def test_cookie_samesite_defaults_to_lax() -> None:
    """An unset SameSite is Lax, the browser default the gate relies on."""
    assert config.cookie_samesite() == config.DEFAULT_COOKIE_SAMESITE


@pytest.mark.parametrize(("configured", "expected"), SECURE_VALUES)
def test_cookie_secure_reads_the_configured_flag(
    monkeypatch: pytest.MonkeyPatch, configured: str, expected: bool
) -> None:
    """Only the documented falsy spellings turn the Secure attribute off."""
    monkeypatch.setenv(config.COOKIE_SECURE_ENV, configured)

    assert config.cookie_secure() is expected


def test_cookie_secure_defaults_to_on() -> None:
    """Unset means Secure: a deployment must opt out of HTTPS-only, not into it."""
    assert config.cookie_secure() is True


@pytest.mark.parametrize(("configured", "expected"), SESSION_DAYS_VALUES)
def test_session_days_falls_back_outside_the_supported_range(
    monkeypatch: pytest.MonkeyPatch, configured: str, expected: int
) -> None:
    """Only a lifetime between one day and the maximum is taken as configured."""
    monkeypatch.setenv(config.SESSION_DAYS_ENV, configured)

    assert config.session_days() == expected


def test_session_days_defaults_to_thirty() -> None:
    """An unset lifetime is the documented default, not an unbounded session."""
    assert config.session_days() == config.DEFAULT_SESSION_DAYS


def test_an_overflowing_session_days_still_boots(build_client: BuildClient) -> None:
    """A fat-fingered lifetime falls back instead of taking create_app() down."""
    # Built with the value: _configure_sessions() feeds it to timedelta() once,
    # at construction time, which is where the OverflowError used to land.
    client: FlaskClient = build_client({config.SESSION_DAYS_ENV: "99999999999"})

    reported: int = client.get("/api/auth/me").get_json()["session_days"]
    assert reported == config.DEFAULT_SESSION_DAYS
