"""Shared pytest fixtures providing an isolated, temp-backed Flask test client.

Each test gets its own fresh on-disk database via the :func:`client` fixture,
which monkeypatches ``db.DATABASE`` and calls ``create_app()`` (so ``init_db()``
runs against the temp database).
"""

from collections.abc import Callable
from pathlib import Path
from typing import Any, Final

import pytest
from flask.testing import FlaskClient
from werkzeug.security import generate_password_hash

from summa import config, create_app, db, ratelimit

SeedInvoice = Callable[..., int]
BuildClient = Callable[..., FlaskClient]

TEST_PASSWORD: Final[str] = "test-password"
ALLOWED_ORIGIN: Final[str] = "https://app.example"
# Hashed once per session: scrypt is deliberately slow, and every gated test
# would otherwise pay for it again.
TEST_PASSWORD_HASH: Final[str] = generate_password_hash(TEST_PASSWORD)

_AUTH_ENV_VARS: Final[tuple[str, ...]] = (
    config.AUTH_ENABLED_ENV,
    config.PASSWORD_HASH_ENV,
    config.SESSION_SECRET_ENV,
    config.SESSION_DAYS_ENV,
    config.COOKIE_SECURE_ENV,
    config.COOKIE_SAMESITE_ENV,
    config.CORS_ORIGINS_ENV,
)


@pytest.fixture(autouse=True)
def isolated_auth_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the operator's own auth/CORS environment out of every test.

    Autouse, so it is applied before the fixtures below: the suite must behave
    identically whether or not the developer has the gate enabled locally.
    """
    for name in _AUTH_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def reset_login_throttle() -> None:
    """Clear the login failure window, which is module state shared across tests."""
    ratelimit.reset()


@pytest.fixture
def auth_enabled(monkeypatch: pytest.MonkeyPatch) -> str:
    """Turn the gate on with a known password, returning that password.

    Must be requested *before* a client fixture, since ``create_app()`` reads
    the cookie configuration once at construction time.
    """
    monkeypatch.setenv(config.AUTH_ENABLED_ENV, "1")
    monkeypatch.setenv(config.PASSWORD_HASH_ENV, TEST_PASSWORD_HASH)
    monkeypatch.setenv(config.SESSION_SECRET_ENV, "test-secret")
    # The test client speaks plain HTTP and would drop a Secure cookie.
    monkeypatch.setenv(config.COOKIE_SECURE_ENV, "0")
    return TEST_PASSWORD


@pytest.fixture
def cross_origin(monkeypatch: pytest.MonkeyPatch) -> str:
    """Allow one explicit cross-origin client, returning its origin.

    Must be requested *before* a client fixture: ``create_app()`` reads the
    allowlist once, when it installs the CORS extension.
    """
    monkeypatch.setenv(config.CORS_ORIGINS_ENV, ALLOWED_ORIGIN)
    return ALLOWED_ORIGIN


@pytest.fixture
def wildcard_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    """Open the wildcard opt-in, as a native mobile client deployment would."""
    monkeypatch.setenv(config.CORS_ORIGINS_ENV, "*")


@pytest.fixture
def build_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> BuildClient:
    """Return a builder for a test client, taking environment overrides.

    For the configuration ``create_app()`` reads once at construction time (the
    cookie attributes, the CORS allowlist), which a plain ``monkeypatch.setenv``
    in the test body would already be too late for.
    """
    db_path: Path = tmp_path / "test.db"
    # get_db() reads this module global on every call, so patching it redirects
    # every connection (including the one init_db() opens) to the temp database.
    monkeypatch.setattr(db, "DATABASE", str(db_path))

    def _build(environment: dict[str, str] | None = None) -> FlaskClient:
        for name, value in (environment or {}).items():
            monkeypatch.setenv(name, value)
        app = create_app()
        app.config["TESTING"] = True
        # Keep producing real 500 responses for uncaught exceptions (as gunicorn
        # does) instead of letting TESTING re-raise them into the test.
        app.config["PROPAGATE_EXCEPTIONS"] = False
        return app.test_client()

    return _build


@pytest.fixture
def client(build_client: BuildClient) -> FlaskClient:
    """Return a Flask test client backed by a fresh, per-test SQLite database."""
    return build_client()


@pytest.fixture
def seed_invoice(client: FlaskClient) -> SeedInvoice:
    """Return a helper that inserts an invoice (and items) straight into the DB."""

    def _seed(
        date: str = "2024-01-15",
        store: str = "Test Store",
        category: str | None = None,
        total: float = 10.0,
        items: list[dict[str, Any]] | None = None,
        deleted: bool = False,
    ) -> int:
        conn = db.get_db()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO invoices (date, store, category, total) VALUES (?, ?, ?, ?)",
            (date, store, category, total),
        )
        invoice_id: int | None = cursor.lastrowid
        assert invoice_id is not None  # AUTOINCREMENT always yields a rowid
        for item in items or []:
            cursor.execute(
                "INSERT INTO invoice_items (invoice_id, item_name, item_price) "
                "VALUES (?, ?, ?)",
                (invoice_id, item["item_name"], item["item_price"]),
            )
        if deleted:
            cursor.execute(
                "UPDATE invoices SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
                (invoice_id,),
            )
        conn.commit()
        conn.close()
        return invoice_id

    return _seed


@pytest.fixture
def gated_client(auth_enabled: str, client: FlaskClient) -> FlaskClient:
    """A test client for an app with the login gate on, not yet logged in."""
    return client


@pytest.fixture
def authed_client(gated_client: FlaskClient) -> FlaskClient:
    """A test client with the login gate on and a valid session cookie."""
    response = gated_client.post(
        "/api/auth/login", json={"password": TEST_PASSWORD, "remember": False}
    )
    assert response.status_code == 200
    return gated_client
