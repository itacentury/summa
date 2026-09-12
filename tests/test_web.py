"""Tests for the web interface routes and the service-worker asset manifests."""

import re
from html.parser import HTMLParser
from pathlib import Path

import pytest
from flask.testing import FlaskClient

from summa.routes.invoices import DEFAULT_PAGE_SIZE

Attributes = dict[str, str | None]


class _AutofocusCollector(HTMLParser):
    """Collect the `[data-autofocus]` elements of every modal overlay."""

    def __init__(self) -> None:
        super().__init__()
        self.targets: dict[str, list[tuple[str, Attributes]]] = {}
        self._modal: str | None = None
        self._depth: int = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes: Attributes = dict(attrs)

        # Only `div` is counted, so the self-closing SVG children inside a modal
        # cannot unbalance the depth. Overlays are never nested in one another.
        if tag == "div":
            if self._modal is None:
                classes: str = attributes.get("class") or ""
                if "modal-overlay" in classes.split():
                    self._modal = attributes.get("data-el") or ""
                    self._depth = 0
                    self.targets.setdefault(self._modal, [])
            else:
                self._depth += 1

        if self._modal is not None and "data-autofocus" in attributes:
            self.targets[self._modal].append((tag, attributes))

    def handle_endtag(self, tag: str) -> None:
        if tag != "div" or self._modal is None:
            return
        if self._depth == 0:
            self._modal = None
            return
        self._depth -= 1


def autofocus_targets(markup: str) -> dict[str, list[tuple[str, Attributes]]]:
    """Map each modal's `data-el` to the `[data-autofocus]` elements inside it."""
    collector: _AutofocusCollector = _AutofocusCollector()
    collector.feed(markup)
    return collector.targets


PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
MODAL_PARTIALS_DIRECTORY: Path = PROJECT_ROOT / "templates" / "partials" / "modals"


def declared_modals() -> set[str]:
    """Collect the `data-el` of every modal overlay partial on disk."""
    declared: set[str] = set()
    for path in MODAL_PARTIALS_DIRECTORY.glob("*.html"):
        declared.update(autofocus_targets(path.read_text()))
    return declared


def test_js_manifest_matches_static_js_directory(client: FlaskClient) -> None:
    """The manifest lists exactly the JS files present under static/js/."""
    response = client.get("/static/js-manifest.json")
    assert response.status_code == 200

    manifest: list[str] = response.get_json()
    assert isinstance(manifest, list)

    js_directory: Path = PROJECT_ROOT / "static" / "js"
    expected: set[str] = {
        f"/static/js/{path.name}" for path in js_directory.glob("*.js")
    }
    assert set(manifest) == expected


def test_css_manifest_matches_static_css_directory(client: FlaskClient) -> None:
    """The manifest lists exactly the CSS files present under static/css/."""
    response = client.get("/static/css-manifest.json")
    assert response.status_code == 200

    manifest: list[str] = response.get_json()
    assert isinstance(manifest, list)

    css_directory: Path = PROJECT_ROOT / "static" / "css"
    expected: set[str] = {
        f"/static/css/{path.name}" for path in css_directory.glob("*.css")
    }
    assert set(manifest) == expected


def test_frontend_default_page_size_matches_backend() -> None:
    """The UI's initial pageSize must equal the backend's DEFAULT_PAGE_SIZE."""
    state_js: Path = PROJECT_ROOT / "static" / "js" / "state.js"
    # Anchored + case-sensitive so it matches `pageSize:` (line 12), never the
    # `effectivePageSize:` line below it.
    match: re.Match[str] | None = re.search(
        r"^\s*pageSize:\s*(\d+)", state_js.read_text(), re.MULTILINE
    )
    assert match is not None, "pageSize default not found in state.js"
    frontend_default: int = int(match.group(1))
    assert frontend_default == DEFAULT_PAGE_SIZE


def test_homepage_hides_ai_trigger_by_default(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The AI trigger is omitted when the master switch is unset."""
    monkeypatch.delenv("ENABLE_AI_SUGGESTIONS", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    response = client.get("/")

    assert response.status_code == 200
    assert 'data-el="ai-categories-trigger"' not in response.get_data(as_text=True)


def test_homepage_renders_ai_trigger_when_master_switch_is_enabled(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The AI trigger is rendered when the master switch is explicitly on."""
    monkeypatch.setenv("ENABLE_AI_SUGGESTIONS", "1")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    response = client.get("/")

    assert response.status_code == 200
    assert 'data-el="ai-categories-trigger"' in response.get_data(as_text=True)


def test_homepage_hides_ai_trigger_when_master_switch_is_disabled(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The AI trigger is omitted from the HTML when the master switch is off."""
    monkeypatch.setenv("ENABLE_AI_SUGGESTIONS", "0")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    response = client.get("/")

    assert response.status_code == 200
    assert 'data-el="ai-categories-trigger"' not in response.get_data(as_text=True)


def test_security_headers_present_on_every_response(client: FlaskClient) -> None:
    """The after_request hook attaches CSP and hardening headers globally."""
    for path in ("/", "/api/invoices"):
        response = client.get(path)
        csp: str | None = response.headers.get("Content-Security-Policy")
        assert csp is not None
        assert "default-src 'self'" in csp
        assert "connect-src 'self'" in csp
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["Referrer-Policy"] == "no-referrer"


@pytest.mark.parametrize(
    ("modal", "tag", "attribute", "value"),
    [
        # The settings dialog focuses its close button so the destructive
        # sign-out row below is never one keystroke away.
        ("settings-modal", "button", "class", "modal-close"),
        ("add-invoice-modal", "input", "data-el", "invoice-date"),
        ("bulk-edit-modal", "input", "data-el", "bulk-edit-store"),
        ("import-modal", "textarea", "data-el", "json-input"),
        # No `.modal-body`, so the fallback would land on the model picker.
        ("categorize-modal", "button", "class", "modal-close"),
        # Read-only overlay: nothing in its body is focusable.
        ("shortcuts-help", "button", "class", "modal-close"),
    ],
)
def test_modal_marks_its_initial_focus_target(
    client: FlaskClient,
    monkeypatch: pytest.MonkeyPatch,
    modal: str,
    tag: str,
    attribute: str,
    value: str,
) -> None:
    """The named modal marks the expected element as its initial focus target."""
    monkeypatch.setenv("ENABLE_AI_SUGGESTIONS", "1")

    response = client.get("/")
    assert response.status_code == 200

    targets: dict[str, list[tuple[str, Attributes]]] = autofocus_targets(
        response.get_data(as_text=True)
    )

    marked: list[tuple[str, Attributes]] = targets.get(modal, [])
    assert len(marked) == 1, f"{modal} must mark exactly one [data-autofocus]"
    marked_tag, attributes = marked[0]
    assert marked_tag == tag
    assert attributes.get(attribute) == value


def test_no_modal_relies_on_the_focus_fallback(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No modal may rely on the DOM-order fallback for its initial focus."""
    monkeypatch.setenv("ENABLE_AI_SUGGESTIONS", "1")

    response = client.get("/")
    assert response.status_code == 200

    targets: dict[str, list[tuple[str, Attributes]]] = autofocus_targets(
        response.get_data(as_text=True)
    )
    assert set(targets) == declared_modals(), (
        "rendered modals do not match templates/partials/modals/ - "
        "a partial is unrendered, feature-flagged off, or no longer collected"
    )

    for modal, marked in targets.items():
        assert len(marked) == 1, (
            f"{modal} must mark exactly one [data-autofocus] element"
        )
