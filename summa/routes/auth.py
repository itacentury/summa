"""Authentication endpoints: login, logout and session status.

These routes stay reachable without a session (see the public allowlist in
:mod:`summa.auth`) — otherwise there would be no way to obtain one.
"""

from datetime import timedelta
from typing import Any

from flask import Blueprint, current_app, jsonify, request

from summa import config
from summa.auth import end_session, is_authenticated, start_session, verify_password
from summa.helpers import ApiResponse, error_response
from summa.ratelimit import login_retry_after, record_failed_login

auth_bp: Blueprint = Blueprint("auth", __name__, url_prefix="/api/auth")


@auth_bp.route("/login", methods=["POST"])
def login() -> ApiResponse:
    """Verify the password and start a session on success."""
    client: str = request.remote_addr or "unknown"
    retry_after: int | None = login_retry_after(client)
    if retry_after is not None:
        response, status = error_response("Too many login attempts", 429)
        response.headers["Retry-After"] = str(retry_after)
        return response, status

    payload: Any = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return error_response("Request body must be a JSON object", 400)

    password: Any = payload.get("password")
    if not isinstance(password, str):
        return error_response("Field 'password' must be a string", 400)

    if not verify_password(password):
        # Only failures are counted, so a correct password never eats into
        # anyone's allowance.
        record_failed_login(client)
        return error_response("Invalid password", 401)

    start_session(remember=payload.get("remember") is True)
    return jsonify({"success": True, "authed": True})


@auth_bp.route("/logout", methods=["POST"])
def logout() -> ApiResponse:
    """Clear the session cookie. Always succeeds."""
    # Clearing an already-empty session still marks it modified, which makes
    # Flask emit a cookie deletion — so a cookie-less cross-site POST could log
    # a real session out. Nothing to clear means nothing to send.
    if is_authenticated():
        end_session()
    return jsonify({"success": True, "authed": False})


@auth_bp.route("/me", methods=["GET"])
def me() -> ApiResponse:
    """Report authentication status for the client-side login gate.

    Answers 200 in every case (never 401) so the gate can ask on each page load
    without producing console errors. ``enabled`` tells the client whether the
    password feature exists at all, which is what hides the sign-out control on
    an unauthenticated deployment. ``session_days`` lets the login screen state
    the lifetime this deployment actually configured instead of a hardcoded one.
    """
    enabled: bool = config.auth_enabled()
    # Read from the app rather than from the environment, and through the same
    # typed accessor Flask's session interface uses for the cookie's max_age, so
    # the label the login screen prints can never promise a lifetime the gate
    # does not enforce.
    lifetime: timedelta = current_app.permanent_session_lifetime
    return jsonify(
        {
            "authed": not enabled or is_authenticated(),
            "enabled": enabled,
            "session_days": lifetime.days,
        }
    )
