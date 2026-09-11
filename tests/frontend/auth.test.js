import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAuthStatus,
  logout,
  renderLoginView,
  setupSignOut,
} from "../../static/js/auth.js";
import { jsonResponse } from "./helpers.js";

/**
 * The real component stylesheet, so the sign-out cases assert what a browser
 * would actually paint rather than only the `hidden` IDL property. Resolved via
 * `import.meta.dirname` because happy-dom replaces the global `URL`, and
 * `node:fs` rejects its file URLs.
 */
const settingsCss = readFileSync(
  join(import.meta.dirname, "../../static/css/settings.css"),
  "utf8",
);

/** Submit the rendered login form and let its async handler settle. */
const submitLogin = async (password, { remember = false } = {}) => {
  const form = document.querySelector(".login-card");
  form.querySelector(".login-input").value = password;
  if (remember) form.querySelector(".login-remember input").checked = true;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled());
  // The handler awaits the response before touching the DOM.
  await Promise.resolve();
  await Promise.resolve();
};

const rememberText = () =>
  document.querySelector(".login-remember span").textContent;

const ariaInvalid = () =>
  document.querySelector(".login-input").getAttribute("aria-invalid");

const errorText = () =>
  document.querySelector(".login-error").hidden
    ? null
    : document.querySelector(".login-error").textContent;

beforeEach(() => {
  document.body.innerHTML = "";
  global.fetch = vi.fn();
});

describe("getAuthStatus", () => {
  it("reports the server's answer", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ authed: true, enabled: true, session_days: 7 }),
    );

    await expect(getAuthStatus()).resolves.toEqual({
      authed: true,
      enabled: true,
      sessionDays: 7,
    });
  });

  it("locks the app when the status request is refused", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 500 }),
    );

    await expect(getAuthStatus()).resolves.toEqual({
      authed: false,
      enabled: true,
      sessionDays: null,
    });
  });

  it("lets an offline PWA boot when the service worker answers 503", async () => {
    // sw.js synthesizes a 503 for /api/* while offline. Showing a login form
    // there would be showing one that cannot possibly succeed.
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 503 }),
    );

    await expect(getAuthStatus()).resolves.toEqual({
      authed: true,
      enabled: null,
      sessionDays: null,
    });
  });

  it("lets the app boot when the network is gone entirely", async () => {
    global.fetch.mockRejectedValue(new Error("offline"));

    await expect(getAuthStatus()).resolves.toEqual({
      authed: true,
      enabled: null,
      sessionDays: null,
    });
  });

  it("treats a malformed payload as unauthenticated", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ authed: "yes" }));

    await expect(getAuthStatus()).resolves.toEqual({
      authed: false,
      enabled: false,
      sessionDays: null,
    });
  });

  it("ignores a session lifetime that is not a positive whole number", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ authed: true, enabled: true, session_days: "soon" }),
    );

    await expect(getAuthStatus()).resolves.toMatchObject({ sessionDays: null });
  });
});

describe("renderLoginView", () => {
  it("hides the app and the modals behind the gate", () => {
    document.body.innerHTML = `
      <div class="app"></div>
      <div class="modal-overlay"></div>
    `;

    renderLoginView(vi.fn());

    // Modals are siblings of .app, so hiding only .app would leave them on top.
    expect(document.querySelector(".app").style.display).toBe("none");
    expect(document.querySelector(".modal-overlay").style.display).toBe("none");
    expect(document.querySelector('[data-el="login-gate"]')).not.toBeNull();
  });

  it("makes everything behind the gate inert", () => {
    document.body.innerHTML = `
      <div class="app"><h1>Summa</h1></div>
      <div class="modal-overlay"></div>
    `;

    renderLoginView(vi.fn());

    for (const selector of [".app", ".modal-overlay"]) {
      expect(document.querySelector(selector).hasAttribute("inert")).toBe(true);
    }
  });

  it("covers the toasts and the bulk toolbar, not just the app", () => {
    // Both are siblings of `.app` and of the modals, so a selector naming only
    // those two left them on top of the gate.
    document.body.innerHTML = `
      <div class="app"></div>
      <div class="modal-overlay"></div>
      <div class="bulk-action-toolbar"></div>
      <div class="toast"></div>
    `;

    renderLoginView(vi.fn());

    for (const selector of [
      ".app",
      ".modal-overlay",
      ".bulk-action-toolbar",
      ".toast",
    ]) {
      const element = document.querySelector(selector);
      expect(element.style.display).toBe("none");
      expect(element.hasAttribute("inert")).toBe(true);
    }
  });

  it("leaves nothing outside the gate focusable", () => {
    // The undo toast is the case that bit: still on screen when the session
    // expires, its buttons invisible behind an opaque gate but tabbable, so
    // "Undo" could be activated blind and fire a request that only 401s.
    document.body.innerHTML = `
      <div class="app"><button>Add</button></div>
      <div class="toast">
        <button data-el="toastUndo">Undo</button>
        <button data-el="toastClose">Close</button>
      </div>
    `;

    renderLoginView(vi.fn());

    const gate = document.querySelector('[data-el="login-gate"]');
    const escaped = Array.from(
      document.querySelectorAll("a[href], button, input, select, textarea"),
    ).filter(
      (element) => !gate.contains(element) && !element.closest("[inert]"),
    );
    expect(escaped).toEqual([]);
  });

  it("restores the toolbar and the toasts once the password is accepted", async () => {
    document.body.innerHTML = `
      <div class="app"></div>
      <div class="bulk-action-toolbar"></div>
      <div class="toast"></div>
    `;
    global.fetch.mockResolvedValue(jsonResponse({ authed: true }));
    renderLoginView(vi.fn());

    await submitLogin("hunter2");

    for (const selector of [".app", ".bulk-action-toolbar", ".toast"]) {
      const element = document.querySelector(selector);
      expect(element.style.display).toBe("");
      expect(element.hasAttribute("inert")).toBe(false);
    }
  });

  it("does not leave a replaced gate hidden in the page", async () => {
    // The replaced gate is removed before the covered set is taken, so it is
    // never restored as if it were part of the app.
    document.body.innerHTML = '<div class="app"></div>';
    global.fetch.mockResolvedValue(jsonResponse({ authed: true }));
    renderLoginView(vi.fn());
    renderLoginView(vi.fn());

    await submitLogin("hunter2");

    expect(document.querySelectorAll('[data-el="login-gate"]')).toHaveLength(0);
    expect(document.querySelector(".app").style.display).toBe("");
  });

  it("leaves the gate's heading as the only one on offer", () => {
    // Two <h1>s exist in the document while the gate is up; only the gate's is
    // reachable, because the app's is inside a hidden, inert subtree.
    document.body.innerHTML = '<div class="app"><h1>Summa</h1></div>';

    renderLoginView(vi.fn());

    const exposed = Array.from(document.querySelectorAll("h1")).filter(
      (heading) => !heading.closest("[inert]"),
    );
    expect(exposed).toHaveLength(1);
    expect(exposed[0].className).toBe("login-title");
  });

  it("names the password field with a real label", () => {
    // A placeholder is not an accessible name: it vanishes on the first
    // keystroke and voice control cannot target it.
    renderLoginView(vi.fn());

    const input = document.querySelector(".login-input");
    const label = document.querySelector(`label[for="${input.id}"]`);
    expect(input.id).not.toBe("");
    expect(label).not.toBeNull();
    expect(label.textContent).toBe("Password");
    // Named for a screen reader, still invisible in the card's design.
    expect(label.className).toBe("visually-hidden");
  });

  it("points the field at the error region and announces it", () => {
    renderLoginView(vi.fn());

    const input = document.querySelector(".login-input");
    const error = document.querySelector(".login-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(error.id).not.toBe("");
  });

  it("replaces an existing gate instead of stacking a second one", () => {
    // Two concurrent expiries would otherwise leave one gate unreachable
    // underneath the other.
    renderLoginView(vi.fn());
    renderLoginView(vi.fn());

    expect(document.querySelectorAll('[data-el="login-gate"]')).toHaveLength(1);
  });

  it("states the lifetime the server reported", async () => {
    // The label is built from the cached status, so the fetch has to happen
    // first — exactly the boot order in app.js.
    global.fetch.mockResolvedValue(
      jsonResponse({ authed: false, enabled: true, session_days: 7 }),
    );
    await getAuthStatus();

    renderLoginView(vi.fn());

    expect(rememberText()).toBe("Stay signed in for 7 days");
  });

  it("says day, not days, for a one-day lifetime", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ authed: false, enabled: true, session_days: 1 }),
    );
    await getAuthStatus();

    renderLoginView(vi.fn());

    expect(rememberText()).toBe("Stay signed in for 1 day");
  });

  it("promises no duration it does not know", async () => {
    // A status request that failed leaves the lifetime unknown; inventing a
    // number here is the bug this replaced.
    global.fetch.mockRejectedValue(new Error("offline"));
    await getAuthStatus();

    renderLoginView(vi.fn());

    expect(rememberText()).toBe("Stay signed in on this device");
  });

  it("sends the password and the remember flag", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ authed: true }));
    renderLoginView(vi.fn());

    await submitLogin("hunter2", { remember: true });

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      password: "hunter2",
      remember: true,
    });
  });

  it("restores the app and calls back once the password is accepted", async () => {
    document.body.innerHTML = '<div class="app"></div>';
    global.fetch.mockResolvedValue(jsonResponse({ authed: true }));
    const onSuccess = vi.fn();
    renderLoginView(onSuccess);

    await submitLogin("hunter2");

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-el="login-gate"]')).toBeNull();
    expect(document.querySelector(".app").style.display).toBe("");
    expect(document.querySelector(".app").hasAttribute("inert")).toBe(false);
  });

  it("keeps the gate up and reports a wrong password", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 401 }),
    );
    const onSuccess = vi.fn();
    renderLoginView(onSuccess);

    await submitLogin("wrong");

    expect(onSuccess).not.toHaveBeenCalled();
    expect(errorText()).toBe("Invalid password");
    expect(ariaInvalid()).toBe("true");
    expect(document.querySelector('[data-el="login-gate"]')).not.toBeNull();
  });

  it("clears the invalid state when the next attempt starts", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 401 }),
    );
    renderLoginView(vi.fn());
    await submitLogin("wrong");

    // A throttled second attempt: the gate stays up, so the reset done at the
    // top of the submit handler is still observable on the field.
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 429 }),
    );
    await submitLogin("hunter2");

    expect(ariaInvalid()).toBe("false");
  });

  it("distinguishes being throttled from being wrong", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 429 }),
    );
    renderLoginView(vi.fn());

    await submitLogin("wrong");

    expect(errorText()).toMatch(/Too many attempts/);
    // Being throttled says nothing about the value that was typed.
    expect(ariaInvalid()).toBe("false");
  });

  it("reports a network failure without blaming the password", async () => {
    global.fetch.mockRejectedValue(new Error("offline"));
    renderLoginView(vi.fn());

    await submitLogin("hunter2");

    expect(errorText()).toMatch(/Network error/);
    expect(ariaInvalid()).toBe("false");
  });

  it("re-enables the submit button after a failure", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 401 }),
    );
    renderLoginView(vi.fn());

    await submitLogin("wrong");

    expect(document.querySelector(".login-submit").disabled).toBe(false);
  });
});

describe("reveal toggle", () => {
  const revealButton = () => document.querySelector(".login-reveal");
  const passwordField = () => document.querySelector(".login-input");

  /** Whether the button shows the crossed-out eye, which only EYE_OFF carries. */
  const isSlashed = () => revealButton().innerHTML.includes('x1="2"');

  /** Assert both halves of the state: the input type and the icon. */
  const expectRevealed = (revealed) => {
    expect(passwordField().type).toBe(revealed ? "text" : "password");
    expect(isSlashed()).toBe(revealed);
  };

  // happy-dom has no PointerEvent constructor, and `blur` does not bubble —
  // both are dispatched straight at the button, where the listeners sit.
  const press = (name) => revealButton().dispatchEvent(new Event(name));

  const key = (name, value) => {
    const event = new KeyboardEvent(name, { key: value, cancelable: true });
    revealButton().dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    renderLoginView(() => {});
  });

  it("starts with the password hidden", () => {
    expectRevealed(false);
  });

  it("reveals the password while the pointer is held", () => {
    press("pointerdown");

    expectRevealed(true);
  });

  it.each(["pointerup", "pointerleave", "pointercancel", "blur"])(
    "hides the password again on %s",
    (name) => {
      // The whole point of a press-and-hold: a released, departed or cancelled
      // pointer — or focus moving away — must never strand the password in
      // plain text.
      press("pointerdown");

      press(name);

      expectRevealed(false);
    },
  );

  it.each([" ", "Enter"])("reveals the password while %s is held", (value) => {
    key("keydown", value);
    expectRevealed(true);

    key("keyup", value);

    expectRevealed(false);
  });

  it("suppresses the browser default on the reveal keys", () => {
    // Space scrolls the page and both keys synthesize a click on keyup, which
    // would fight the hold by toggling the state a second time.
    expect(key("keydown", " ").defaultPrevented).toBe(true);
    expect(key("keydown", "Enter").defaultPrevented).toBe(true);
  });

  it("ignores keys that are not the reveal keys", () => {
    key("keydown", "a");

    expectRevealed(false);
  });

  it("keeps the focus on the password input", () => {
    // Without this, clicking the eye would move focus off the input and Enter
    // would re-trigger the button instead of submitting the form.
    const event = new MouseEvent("mousedown", { cancelable: true });
    revealButton().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("setupSignOut", () => {
  beforeEach(() => {
    // happy-dom ships no UA stylesheet, so the `[hidden]` default is stated
    // here. It comes first, exactly as the UA origin would: settings.css can
    // still override it by cascade order, which is the bug being guarded.
    document.body.innerHTML = `
      <style>[hidden] { display: none }</style>
      <style>${settingsCss}</style>
      <button class="settings-action" data-el="logout" hidden></button>`;
  });

  it("reveals the control when the gate is enabled", () => {
    setupSignOut(true);

    const button = document.querySelector('[data-el="logout"]');
    expect(button.hidden).toBe(false);
    expect(getComputedStyle(button).display).toBe("flex");
  });

  it("leaves it hidden on a deployment without a password", () => {
    setupSignOut(false);

    const button = document.querySelector('[data-el="logout"]');
    expect(button.hidden).toBe(true);
    expect(getComputedStyle(button).display).toBe("none");
  });

  it("leaves it hidden while the gate state is unknown", () => {
    setupSignOut(null);

    const button = document.querySelector('[data-el="logout"]');
    expect(button.hidden).toBe(true);
    button.click();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reveals it once the network comes back after an offline boot", async () => {
    setupSignOut(null);
    global.fetch.mockResolvedValue(
      jsonResponse({ authed: true, enabled: true, session_days: 7 }),
    );

    window.dispatchEvent(new Event("online"));
    const button = document.querySelector('[data-el="logout"]');
    await vi.waitFor(() => expect(button.hidden).toBe(false));

    expect(getComputedStyle(button).display).toBe("flex");
  });

  it("wires the control only once across repeated setup", async () => {
    setupSignOut(true);
    setupSignOut(true);

    document.querySelector('[data-el="logout"]').click();

    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("logout", () => {
  it("posts to the logout endpoint", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ authed: false }));

    await logout();

    expect(global.fetch).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
    });
  });

  it("resolves even when the request fails", async () => {
    // The caller reloads either way, and the cookie may already be gone.
    global.fetch.mockRejectedValue(new Error("offline"));

    await expect(logout()).resolves.toBeUndefined();
  });
});
