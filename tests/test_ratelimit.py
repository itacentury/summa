"""Unit tests for the login failure store in :mod:`summa.ratelimit`.

These go at the module rather than the endpoint, because what is under test is
the bookkeeping of the store itself: the HTTP-level throttling behaviour is
covered in ``tests/test_auth.py``. The ``reset_login_throttle`` fixture in
``conftest.py`` is autouse, so each test starts with an empty store.
"""

import time

import pytest

from summa import ratelimit


def test_probing_does_not_start_tracking_a_client() -> None:
    """Asking about a client must not create an entry for it.

    Every login request calls ``login_retry_after()``, including the ones that
    never record a failure (malformed body, successful login). If the read path
    inserted, those requests would grow the store past its cap unchecked.
    """
    for index in range(50_000):
        assert ratelimit.login_retry_after(f"10.0.0.{index}") is None

    assert ratelimit._failures == {}


def test_a_failure_after_a_probe_is_still_counted() -> None:
    """Pruning on the read path must not detach the list a failure lands in."""
    assert ratelimit.login_retry_after("10.0.0.1") is None

    for _ in range(ratelimit.MAX_FAILURES):
        ratelimit.record_failed_login("10.0.0.1")

    retry_after: int | None = ratelimit.login_retry_after("10.0.0.1")
    assert retry_after is not None
    assert retry_after > 0


def test_the_cap_holds_when_nothing_is_stale(monkeypatch: pytest.MonkeyPatch) -> None:
    """A spray of forged addresses inside one window cannot grow the store."""
    monkeypatch.setattr(ratelimit, "MAX_TRACKED_CLIENTS", 5)

    for index in range(50):
        ratelimit.record_failed_login(f"10.0.0.{index}")

    assert len(ratelimit._failures) <= 5


def test_eviction_keeps_the_most_recent_clients(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The clients dropped are the ones whose last failure is furthest back."""
    monkeypatch.setattr(ratelimit, "MAX_TRACKED_CLIENTS", 5)

    for index in range(50):
        ratelimit.record_failed_login(f"10.0.0.{index}")

    assert set(ratelimit._failures) == {f"10.0.0.{index}" for index in range(45, 50)}
    # An evicted client is forgotten, not locked out.
    assert ratelimit.login_retry_after("10.0.0.0") is None


def test_stale_clients_are_dropped_before_the_recent_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Failures that aged out of the window are what the cap frees first."""
    monkeypatch.setattr(ratelimit, "MAX_TRACKED_CLIENTS", 2)
    stale_stamp: float = time.time() - ratelimit.WINDOW_SECONDS - 1
    for index in range(10):
        ratelimit._failures[f"10.0.0.{index}"] = [stale_stamp]
    ratelimit.record_failed_login("10.0.0.100")
    ratelimit.record_failed_login("10.0.0.101")

    ratelimit.record_failed_login("10.0.0.102")

    assert set(ratelimit._failures) == {"10.0.0.101", "10.0.0.102"}
