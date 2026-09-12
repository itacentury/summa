"""In-process sliding-window throttling for failed login attempts.

Scoped deliberately to ``/api/auth/login`` rather than the whole API: locking a
client out of the app shell is the worse failure mode, while an unthrottled
login is a standing invitation to guess the one password the deployment has.
Only *failures* are counted, so normal use never runs into the limit.

Two limitations follow from keeping the state in memory, and both are accepted
for a self-hosted single-user app:

* The store is per process, so ``gunicorn --workers 2`` multiplies the
  effective allowance by two.
* The client is identified by ``request.remote_addr``, which behind a reverse
  proxy is the proxy itself — collapsing every client onto one bucket. Fixing
  that needs ``ProxyFix`` plus a trusted-proxy list.
"""

import threading
import time
from typing import Final

# Ten wrong guesses per five minutes is far below what a brute-force run needs
# and far above what a person mistyping their password will hit.
MAX_FAILURES: Final[int] = 10
WINDOW_SECONDS: Final[float] = 300.0

# Bound on distinct clients tracked at once, so a spray of forged source
# addresses cannot grow the store without limit.
MAX_TRACKED_CLIENTS: Final[int] = 10_000

# Written only by record_failed_login(), which keeps two invariants the eviction
# helpers rely on: a stored list is never empty, and its timestamps ascend.
_failures: dict[str, list[float]] = {}
_lock: threading.Lock = threading.Lock()


def _recent_failures(client: str, cutoff: float) -> list[float]:
    """Return the client's failures inside the window. Caller holds the lock.

    Reads only: asking about a client must not start tracking it, or every
    login request would grow the store past the cap.
    """
    return [stamp for stamp in _failures.get(client, []) if stamp > cutoff]


def _evict_stale(cutoff: float) -> None:
    """Drop clients whose failures all fell out of the window. Caller holds the lock."""
    stale: list[str] = [
        client for client, timestamps in _failures.items() if timestamps[-1] <= cutoff
    ]
    for client in stale:
        del _failures[client]


def _evict_oldest(surplus: int) -> None:
    """Drop the ``surplus`` clients whose last failure is furthest in the past.

    The stale sweep frees nothing when every tracked client failed inside the
    window, which is exactly the spray the cap exists for. Caller holds the lock.

    :param surplus: how many clients the store is over the cap; ``<= 0`` is a no-op.
    """
    if surplus <= 0:
        return
    ranked: list[str] = sorted(_failures, key=lambda client: _failures[client][-1])
    for client in ranked[:surplus]:
        del _failures[client]


def login_retry_after(client: str) -> int | None:
    """Return how many seconds a locked-out client must wait, or ``None`` if free.

    :param client: an identifier for the caller, normally its IP address.
    """
    cutoff: float = time.time() - WINDOW_SECONDS
    with _lock:
        recent: list[float] = _recent_failures(client, cutoff)
        if len(recent) < MAX_FAILURES:
            return None
        # The oldest failure is what has to age out of the window before the
        # client gets its next attempt.
        return max(1, int(recent[0] - cutoff) + 1)


def record_failed_login(client: str) -> None:
    """Count one wrong password against the client's window."""
    now: float = time.time()
    cutoff: float = now - WINDOW_SECONDS
    with _lock:
        recent: list[float] = _recent_failures(client, cutoff)
        recent.append(now)
        _failures[client] = recent
        # Enforce after storing, so this client's own entry is the newest one
        # and cannot be what either sweep drops.
        if len(_failures) > MAX_TRACKED_CLIENTS:
            _evict_stale(cutoff)
            _evict_oldest(len(_failures) - MAX_TRACKED_CLIENTS)


def reset() -> None:
    """Forget every recorded failure. Intended for tests."""
    with _lock:
        _failures.clear()
