"""Tests for the login, logout and session-status endpoints."""

import logging
import time
from datetime import timedelta

import pytest
from flask import Flask
from flask.sessions import SecureCookieSessionInterface
from flask.testing import FlaskClient
from itsdangerous import TimestampSigner
from werkzeug.test import TestResponse

from summa import auth, config, ratelimit
from tests.conftest import TEST_PASSWORD, TEST_PASSWORD_HASH, BuildClient

# Every shape a hash can arrive in that Werkzeug cannot read. The first four are
# what Docker Compose's '$' interpolation leaves behind; only the last two reach
# check_password_hash's ValueError, the rest come back as a plain False.
UNREADABLE_HASHES: list[str] = [
    "not-a-real-hash",
    "scrypt:32768:8:1$$",
    "scrypt:32768:8:1$$abcd",
    "$salt$abcd",
    "notamethod$salt$abcd",
    "scrypt:32768:8$salt$abcd",
]


def _session_cookies(response: TestResponse) -> list[str]:
    """Return every Set-Cookie header that carries the session cookie."""
    headers: list[str] = response.headers.getlist("Set-Cookie")
    return [value for value in headers if "summa_session=" in value]


def _session_cookie(response: TestResponse) -> str:
    """Return the Set-Cookie header that carries the session cookie."""
    matching: list[str] = _session_cookies(response)
    assert matching, f"no session cookie in {response.headers.getlist('Set-Cookie')}"
    return matching[0]


def _backdated_session_cookie(app: Flask, age: timedelta) -> str:
    """Mint a valid session cookie, signed as if it had been issued `age` ago.

    The alternative is sleeping past a shortened lifetime, which buys the same
    assertion for a slower, flakier test.
    """
    interface = app.session_interface
    # Narrowed rather than assumed: only the signed-cookie interface has a
    # serializer to borrow, and it is what create_app() leaves in place.
    assert isinstance(interface, SecureCookieSessionInterface)
    serializer = interface.get_signing_serializer(app)
    assert serializer is not None, "the app has no signing key"

    class BackdatedSigner(TimestampSigner):
        """A signer that stamps the cookie into the past."""

        def get_timestamp(self) -> int:
            return int(time.time() - age.total_seconds())

    # `signer` is the class make_signer() instantiates; overriding it on this
    # one serializer backdates the timestamp Flask checks max_age against.
    serializer.signer = BackdatedSigner
    return serializer.dumps({"authed": True})


def test_login_with_correct_password_starts_a_session(
    gated_client: FlaskClient,
) -> None:
    """The right password answers 200 and sets the session cookie."""
    response = gated_client.post("/api/auth/login", json={"password": TEST_PASSWORD})

    assert response.status_code == 200
    assert response.get_json() == {"success": True, "authed": True}
    assert "HttpOnly" in _session_cookie(response)


def test_login_with_wrong_password_is_rejected(gated_client: FlaskClient) -> None:
    """A wrong password answers 401 and sets no cookie."""
    response = gated_client.post("/api/auth/login", json={"password": "wrong"})

    assert response.status_code == 401
    assert response.get_json() == {"success": False, "error": "Invalid password"}
    assert not response.headers.getlist("Set-Cookie")


def test_login_requires_a_string_password(gated_client: FlaskClient) -> None:
    """A non-string password is a client error, not an auth failure."""
    response = gated_client.post("/api/auth/login", json={"password": 1234})

    assert response.status_code == 400


def test_login_requires_a_json_object(gated_client: FlaskClient) -> None:
    """A non-object body is rejected before the password is looked at."""
    response = gated_client.post("/api/auth/login", json=["not", "an", "object"])

    assert response.status_code == 400


def test_login_without_a_configured_hash_always_fails(
    gated_client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A gate without a password hash fails closed rather than open."""
    monkeypatch.setenv(config.PASSWORD_HASH_ENV, "")

    response = gated_client.post("/api/auth/login", json={"password": TEST_PASSWORD})

    assert response.status_code == 401


def test_login_with_a_malformed_hash_fails_closed(
    gated_client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A mangled hash yields 401, never a 500."""
    monkeypatch.setenv(config.PASSWORD_HASH_ENV, "not-a-real-hash")

    response = gated_client.post("/api/auth/login", json={"password": TEST_PASSWORD})

    assert response.status_code == 401


@pytest.mark.parametrize("configured_hash", UNREADABLE_HASHES)
def test_login_with_an_unreadable_hash_never_500s(
    gated_client: FlaskClient, monkeypatch: pytest.MonkeyPatch, configured_hash: str
) -> None:
    """Every unreadable hash shape is a 401 — including the ones that raise."""
    monkeypatch.setenv(config.PASSWORD_HASH_ENV, configured_hash)

    response = gated_client.post("/api/auth/login", json={"password": TEST_PASSWORD})

    assert response.status_code == 401


def test_login_with_an_unknown_hash_method_is_logged(
    gated_client: FlaskClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The shapes Werkzeug raises on say so in the log rather than 500-ing."""
    monkeypatch.setenv(config.PASSWORD_HASH_ENV, "notamethod$salt$abcd")

    with caplog.at_level(logging.WARNING, logger="summa.auth"):
        response = gated_client.post(
            "/api/auth/login", json={"password": TEST_PASSWORD}
        )

    assert response.status_code == 401
    assert "is not a valid hash" in caplog.text


def test_remember_makes_the_cookie_persistent(gated_client: FlaskClient) -> None:
    """With `remember` the cookie carries an expiry."""
    response = gated_client.post(
        "/api/auth/login", json={"password": TEST_PASSWORD, "remember": True}
    )

    assert "Expires=" in _session_cookie(response)


def test_a_remembered_session_is_not_renewed_by_use(gated_client: FlaskClient) -> None:
    """The expiry is fixed at login, so an active session still hard-expires."""
    gated_client.post(
        "/api/auth/login", json={"password": TEST_PASSWORD, "remember": True}
    )

    response = gated_client.get("/api/invoices")

    assert response.status_code == 200
    assert not response.headers.getlist("Set-Cookie")


def test_without_remember_the_cookie_is_session_scoped(
    gated_client: FlaskClient,
) -> None:
    """Without `remember` the browser drops the cookie on close."""
    response = gated_client.post(
        "/api/auth/login", json={"password": TEST_PASSWORD, "remember": False}
    )

    assert "Expires=" not in _session_cookie(response)


def test_a_session_older_than_its_lifetime_is_refused(
    gated_client: FlaskClient,
) -> None:
    """The hard expiry the fixed cookie timestamp exists for actually bites."""
    expired: str = _backdated_session_cookie(
        gated_client.application,
        timedelta(days=config.DEFAULT_SESSION_DAYS + 1),
    )
    gated_client.set_cookie("summa_session", expired)

    assert gated_client.get("/api/invoices").status_code == 401


def test_a_session_inside_its_lifetime_is_accepted(gated_client: FlaskClient) -> None:
    """Guards the test above: an unreadable cookie would 401 for the wrong reason."""
    still_valid: str = _backdated_session_cookie(
        gated_client.application,
        timedelta(days=config.DEFAULT_SESSION_DAYS - 1),
    )
    gated_client.set_cookie("summa_session", still_valid)

    assert gated_client.get("/api/invoices").status_code == 200


def test_a_cookie_signed_with_another_secret_is_refused(
    authed_client: FlaskClient, build_client: BuildClient
) -> None:
    """Rotating SESSION_SECRET is the one lever that invalidates every session."""
    stolen = authed_client.get_cookie("summa_session")
    assert stolen is not None

    rotated: FlaskClient = build_client({config.SESSION_SECRET_ENV: "rotated-secret"})
    rotated.set_cookie("summa_session", stolen.value)

    assert rotated.get("/api/invoices").status_code == 401


def test_a_session_survives_a_restart_with_the_same_secret(
    authed_client: FlaskClient, build_client: BuildClient
) -> None:
    """Guards the test above: sessions are stateless, so only the secret matters."""
    kept = authed_client.get_cookie("summa_session")
    assert kept is not None

    restarted: FlaskClient = build_client()
    restarted.set_cookie("summa_session", kept.value)

    assert restarted.get("/api/invoices").status_code == 200


def test_the_cookie_carries_the_configured_samesite(
    auth_enabled: str, build_client: BuildClient
) -> None:
    """COOKIE_SAMESITE reaches the browser, not just the config accessor."""
    client: FlaskClient = build_client({config.COOKIE_SAMESITE_ENV: "strict"})

    response = client.post("/api/auth/login", json={"password": auth_enabled})

    assert "SameSite=Strict" in _session_cookie(response)


def test_an_unknown_samesite_falls_back_on_the_cookie(
    auth_enabled: str, build_client: BuildClient
) -> None:
    """A typo must degrade to Lax rather than reach Flask, which raises on it."""
    client: FlaskClient = build_client({config.COOKIE_SAMESITE_ENV: "banana"})

    response = client.post("/api/auth/login", json={"password": auth_enabled})

    assert "SameSite=Lax" in _session_cookie(response)


def test_the_cookie_is_secure_by_default(
    auth_enabled: str, build_client: BuildClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A deployment opts out of HTTPS-only; it never has to opt in."""
    # The auth_enabled fixture switches Secure off for the plain-HTTP test client.
    monkeypatch.delenv(config.COOKIE_SECURE_ENV)
    client: FlaskClient = build_client()

    response = client.post("/api/auth/login", json={"password": auth_enabled})

    cookie: str = _session_cookie(response)
    assert "Secure" in cookie
    assert "HttpOnly" in cookie


def test_the_secure_attribute_can_be_switched_off(
    auth_enabled: str, build_client: BuildClient
) -> None:
    """Plain-HTTP deployments (and this suite) need the escape hatch to work."""
    client: FlaskClient = build_client({config.COOKIE_SECURE_ENV: "0"})

    response = client.post("/api/auth/login", json={"password": auth_enabled})

    assert "Secure" not in _session_cookie(response)


def test_logout_clears_the_session(authed_client: FlaskClient) -> None:
    """After logout the status endpoint reports an unauthenticated client."""
    response = authed_client.post("/api/auth/logout")

    assert response.status_code == 200
    assert response.get_json() == {"success": True, "authed": False}
    assert authed_client.get("/api/auth/me").get_json() == {
        "authed": False,
        "enabled": True,
        "session_days": 30,
    }


def test_logout_without_a_session_sends_no_cookie(gated_client: FlaskClient) -> None:
    """A cookie-less logout must not emit a deletion a cross-site POST could use."""
    response = gated_client.post("/api/auth/logout")

    assert response.status_code == 200
    assert response.get_json() == {"success": True, "authed": False}
    assert not _session_cookies(response)


def test_logout_is_inert_when_the_gate_is_off(client: FlaskClient) -> None:
    """The endpoint stays reachable on an ungated deployment and touches nothing."""
    response = client.post("/api/auth/logout")

    assert response.status_code == 200
    assert response.get_json() == {"success": True, "authed": False}
    assert not _session_cookies(response)


def test_me_reports_an_authenticated_client(authed_client: FlaskClient) -> None:
    """A logged-in client is reported as authed with the gate enabled."""
    response = authed_client.get("/api/auth/me")

    assert response.status_code == 200
    assert response.get_json() == {
        "authed": True,
        "enabled": True,
        "session_days": 30,
    }


def test_me_reports_a_missing_session_with_200(gated_client: FlaskClient) -> None:
    """The status endpoint answers 200 even when the client must log in."""
    response = gated_client.get("/api/auth/me")

    assert response.status_code == 200
    assert response.get_json() == {
        "authed": False,
        "enabled": True,
        "session_days": 30,
    }


def test_me_reports_everyone_as_authed_when_the_gate_is_off(
    client: FlaskClient,
) -> None:
    """With the gate disabled the client is authed and the logout UI stays hidden."""
    response = client.get("/api/auth/me")

    assert response.status_code == 200
    assert response.get_json() == {
        "authed": True,
        "enabled": False,
        "session_days": 30,
    }


def test_me_reports_the_configured_session_lifetime(
    build_client: BuildClient,
) -> None:
    """A custom SESSION_DAYS reaches the client, which labels the login screen."""
    # Built with the value: create_app() freezes the lifetime that me() reports.
    client: FlaskClient = build_client({config.SESSION_DAYS_ENV: "7"})

    assert client.get("/api/auth/me").get_json()["session_days"] == 7


def test_the_reported_lifetime_is_the_one_the_gate_enforces(
    auth_enabled: str, build_client: BuildClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The label the login screen prints is the expiry the cookie is checked against."""
    client: FlaskClient = build_client({config.SESSION_DAYS_ENV: "7"})
    # The divergence is the test: the app froze 7 at boot, the environment now
    # says otherwise, so a per-request read of SESSION_DAYS would report 365 and
    # promise a lifetime no cookie gets.
    monkeypatch.setenv(config.SESSION_DAYS_ENV, "365")

    reported: int = client.get("/api/auth/me").get_json()["session_days"]
    assert reported == 7

    client.set_cookie(
        "summa_session",
        _backdated_session_cookie(client.application, timedelta(days=reported + 1)),
    )
    assert client.get("/api/invoices").status_code == 401

    # The other side of the boundary, which pins the enforced window to exactly
    # the reported number rather than to anything at least that long.
    client.set_cookie(
        "summa_session",
        _backdated_session_cookie(client.application, timedelta(days=reported - 1)),
    )
    assert client.get("/api/invoices").status_code == 200


def test_repeated_wrong_passwords_are_throttled(gated_client: FlaskClient) -> None:
    """Guessing is cut off once the failure window is full."""
    for _ in range(ratelimit.MAX_FAILURES):
        assert (
            gated_client.post("/api/auth/login", json={"password": "wrong"}).status_code
            == 401
        )

    response = gated_client.post("/api/auth/login", json={"password": "wrong"})

    assert response.status_code == 429
    assert response.get_json()["error"] == "Too many login attempts"
    assert int(response.headers["Retry-After"]) > 0


def test_throttling_outlasts_the_correct_password(gated_client: FlaskClient) -> None:
    """A locked-out client cannot get in by finally guessing right."""
    for _ in range(ratelimit.MAX_FAILURES):
        gated_client.post("/api/auth/login", json={"password": "wrong"})

    response = gated_client.post("/api/auth/login", json={"password": TEST_PASSWORD})

    assert response.status_code == 429


def test_successful_logins_are_not_counted(gated_client: FlaskClient) -> None:
    """Normal use never runs into the limit, because only failures are recorded."""
    for _ in range(ratelimit.MAX_FAILURES * 2):
        response = gated_client.post(
            "/api/auth/login", json={"password": TEST_PASSWORD}
        )
        assert response.status_code == 200


def test_a_sound_configuration_warns_about_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A set secret and a readable hash produce no startup warnings."""
    monkeypatch.setenv(config.SESSION_SECRET_ENV, "test-secret")
    monkeypatch.setenv(config.PASSWORD_HASH_ENV, TEST_PASSWORD_HASH)

    assert auth.auth_config_warnings() == []


def test_a_missing_hash_warns_that_none_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unset hash reads as "not configured", not as an unreadable one."""
    monkeypatch.setenv(config.SESSION_SECRET_ENV, "test-secret")

    warnings: list[str] = auth.auth_config_warnings()

    assert warnings == [
        f"No password configured — set {config.PASSWORD_HASH_ENV} "
        "(generate one with: uv run python -m summa.hashpw)"
    ]


@pytest.mark.parametrize("configured_hash", UNREADABLE_HASHES)
def test_an_unreadable_hash_warns_at_startup(
    monkeypatch: pytest.MonkeyPatch, configured_hash: str
) -> None:
    """The mangling the login path cannot report is caught where an operator looks."""
    monkeypatch.setenv(config.SESSION_SECRET_ENV, "test-secret")
    monkeypatch.setenv(config.PASSWORD_HASH_ENV, configured_hash)

    warnings: list[str] = auth.auth_config_warnings()

    assert len(warnings) == 1
    assert "is not a readable hash" in warnings[0]


def test_a_missing_session_secret_warns_at_startup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unsigned-key deployment is reported alongside a sound password."""
    monkeypatch.setenv(config.PASSWORD_HASH_ENV, TEST_PASSWORD_HASH)

    warnings: list[str] = auth.auth_config_warnings()

    assert len(warnings) == 1
    assert config.SESSION_SECRET_ENV in warnings[0]
