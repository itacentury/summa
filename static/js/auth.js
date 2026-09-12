/**
 * Client-side login gate.
 *
 * The app shell is served publicly and only the API routes are protected, so
 * this module asks the server whether a session exists, renders a login view
 * when it does not, and exposes a sign-out helper.
 *
 * The form is built through the DOM API rather than a template: the CSP is
 * `script-src 'self'` / `style-src 'self'` without `unsafe-inline`, so inline
 * handlers and `style` attributes are both blocked. Setting `el.style.*` from
 * script is unaffected — the same reasoning as `applyCategoryBadge()` in dom.js.
 */

/**
 * Ids for the two ARIA relationships the login form needs: `label[for]` naming
 * the password input, and `aria-describedby` pointing it at the error message.
 * Ids rather than `data-el` hooks because both attributes reference by id.
 * Unique by construction — `renderLoginView()` removes any existing gate first.
 */
const PASSWORD_ID = "login-password";
const ERROR_ID = "login-error";

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

/**
 * Last session lifetime reported by the server, or null while it is unknown.
 *
 * Cached at module scope because `renderLoginView()` is also called from the
 * session-expiry path in app.js, which has no status object in hand.
 * `getAuthStatus()` always runs first at boot, so the value is known by then.
 */
let knownSessionDays = null;

/**
 * Fetch the current authentication status.
 *
 * @returns {Promise<{authed: boolean, enabled: boolean|null, sessionDays: number|null}>}
 *   `authed` is whether the app may start, `enabled` whether the password gate
 *   exists at all (which is what decides if the sign-out control is shown) —
 *   true for on, false for off, and null while the server cannot be reached, so
 *   an unknown is never mistaken for a deployment without a password — and
 *   `sessionDays` how long "stay signed in" lasts (null when unknown).
 */
export async function getAuthStatus() {
  // Cleared up front so a failed status never leaves a stale duration behind to
  // be printed as fact on the next gate.
  knownSessionDays = null;
  try {
    // Bare fetch, not apiFetch(): see the login submit in renderLoginView().
    const response = await fetch("/api/auth/me");
    // The service worker answers /api/* with a synthetic 503 while offline.
    // Treating that as "not logged in" would show a login form that cannot
    // possibly succeed, so an offline PWA is let through instead.
    if (response.status === 503)
      return { authed: true, enabled: null, sessionDays: null };
    if (!response.ok)
      return { authed: false, enabled: true, sessionDays: null };
    const data = await response.json();
    const days = Number(data.session_days);
    knownSessionDays = Number.isInteger(days) && days > 0 ? days : null;
    return {
      authed: data.authed === true,
      enabled: data.enabled === true,
      sessionDays: knownSessionDays,
    };
  } catch {
    // Network error without a service worker: same reasoning as the 503 above.
    return { authed: true, enabled: null, sessionDays: null };
  }
}

/**
 * Sign out by clearing the server-side session cookie.
 *
 * @returns {Promise<void>}
 */
export async function logout() {
  try {
    // Bare fetch, not apiFetch(): see the login submit in renderLoginView().
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Ignore network errors: the cookie may already be gone, and the caller
    // reloads either way.
  }
}

/**
 * Reveal and wire the sign-out control, retrying once the answer is knowable.
 *
 * @param {boolean|null} enabled - Whether the deployment has the password gate
 *   on. When it is off the button stays hidden rather than offering to end a
 *   session that does not exist. When it is unknown — the boot ran offline —
 *   the control would otherwise stay hidden for the life of the page, so the
 *   status is asked for again as soon as the network comes back.
 */
export function setupSignOut(enabled) {
  const button = document.querySelector('[data-el="logout"]');
  if (!button) return;

  if (enabled === null) {
    // Only "the network came back" is caught here. A server that was down while
    // the browser stayed online never fires this, and still needs a reload —
    // the same tradeoff the offline branch of getAuthStatus() already accepts.
    const retry = async () => setupSignOut((await getAuthStatus()).enabled);
    window.addEventListener("online", retry, { once: true });
    return;
  }
  if (!enabled) return;

  button.hidden = false;

  // setupSignOut() can run more than once per page (the retry above), and a
  // second listener would sign out and reload twice over.
  if (button.dataset.wired) return;
  button.dataset.wired = "true";

  button.addEventListener("click", async () => {
    await logout();
    // A full reload rather than re-rendering the gate in place: signing out
    // ends the session deliberately, and reloading is the cheapest way to
    // guarantee every listener, timer and cached render is gone.
    location.reload();
  });
}

/**
 * Build the password field: a hidden label, an input and a press-and-hold
 * reveal toggle.
 *
 * @returns {{label: HTMLLabelElement, wrap: HTMLDivElement, input: HTMLInputElement}}
 */
function buildPasswordField() {
  const wrap = document.createElement("div");
  wrap.className = "login-password";

  const input = document.createElement("input");
  input.type = "password";
  input.className = "login-input";
  // A placeholder is not a name: it disappears on the first keystroke and
  // voice control cannot target it, hence the real label below.
  input.placeholder = "Password";
  input.id = PASSWORD_ID;
  input.setAttribute("aria-describedby", ERROR_ID);
  input.setAttribute("aria-invalid", "false");
  // Without this, most password managers ignore the field entirely.
  input.autocomplete = "current-password";
  input.required = true;

  const label = document.createElement("label");
  label.className = "visually-hidden";
  label.htmlFor = PASSWORD_ID;
  label.textContent = "Password";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "login-reveal";
  toggle.setAttribute("aria-label", "Show password (press and hold)");
  toggle.innerHTML = EYE_OPEN;

  const show = () => {
    input.type = "text";
    toggle.innerHTML = EYE_OFF;
  };
  const hide = () => {
    input.type = "password";
    toggle.innerHTML = EYE_OPEN;
  };

  // Keep focus on the input, so Enter still submits the form instead of
  // re-triggering this button.
  toggle.addEventListener("mousedown", (event) => event.preventDefault());

  // Press-and-hold rather than a latch, and four ways to hide: a pointer can
  // leave the button, be cancelled by a gesture, or the button can lose focus —
  // any of which would otherwise strand the password in plain text.
  toggle.addEventListener("pointerdown", show);
  for (const name of ["pointerup", "pointerleave", "pointercancel", "blur"]) {
    toggle.addEventListener(name, hide);
  }
  toggle.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      show();
    }
  });
  toggle.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") hide();
  });

  wrap.append(input, toggle);
  return { label, wrap, input };
}

/**
 * Build the "stay signed in" row.
 *
 * @param {number|null} days - The configured session lifetime. When it is
 *   unknown the label states no duration at all rather than inventing one.
 * @returns {{label: HTMLLabelElement, checkbox: HTMLInputElement}}
 */
function buildRememberField(days) {
  const label = document.createElement("label");
  label.className = "login-remember";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";

  const text = document.createElement("span");
  text.textContent = days
    ? `Stay signed in for ${days} ${days === 1 ? "day" : "days"}`
    : "Stay signed in on this device";

  label.append(checkbox, text);
  return { label, checkbox };
}

/**
 * Render the login view, hiding the app until the password is accepted.
 *
 * Safe to call again mid-session (an expired cookie): an existing gate is
 * replaced rather than stacked on top of.
 *
 * @param {() => void} onSuccess - Called once, after a successful login.
 */
export function renderLoginView(onSuccess) {
  // Removed before the snapshot below, so a stale gate is never captured as
  // something to hide and later restore.
  document.querySelector('[data-el="login-gate"]')?.remove();

  // Everything else in <body> goes behind the gate — not just `.app` and the
  // modals, but the bulk-action toolbar and the toasts, which are siblings of
  // both and stayed focusable while the gate was up. Iterating the body rather
  // than naming selectors means a future body-level sibling is covered without
  // touching this code; the non-rendered children (`<script>`) come along too,
  // where both `display: none` and `inert` are no-ops.
  //
  // Hidden via `style.display` rather than a class so nothing can collide with
  // the app's own display rules; restored to "" (not "block") to hand control
  // back. `inert` alongside it states the intent that nothing behind the gate
  // is reachable: `display: none` already drops the app's own <h1> and its
  // focusables, so the gate's <h1> is the document's only exposed heading.
  const covered = Array.from(document.body.children);
  for (const element of covered) {
    element.style.display = "none";
    element.toggleAttribute("inert", true);
  }

  const gate = document.createElement("div");
  gate.dataset.el = "login-gate";
  gate.className = "login-gate";

  const card = document.createElement("form");
  card.className = "login-card";
  // The form element buys Enter-to-submit and password-manager integration;
  // novalidate suppresses the native bubble so the inline message is the only
  // error UI, while `required` stays on the input as an accessibility hint.
  card.noValidate = true;

  const title = document.createElement("h1");
  title.className = "login-title";
  title.textContent = "Summa";

  const subtitle = document.createElement("p");
  subtitle.className = "login-subtitle";
  subtitle.textContent = "Enter your password to continue";

  const {
    label: passwordLabel,
    wrap: passwordWrap,
    input: passwordInput,
  } = buildPasswordField();
  const { label: rememberLabel, checkbox: rememberCheckbox } =
    buildRememberField(knownSessionDays);

  const error = document.createElement("p");
  error.className = "login-error";
  error.id = ERROR_ID;
  error.setAttribute("role", "alert");
  error.hidden = true;

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "login-submit";
  submit.textContent = "Sign in";

  card.append(
    title,
    subtitle,
    passwordLabel,
    passwordWrap,
    rememberLabel,
    error,
    submit,
  );
  gate.appendChild(card);
  document.body.appendChild(gate);
  passwordInput.focus();

  const fail = (message) => {
    // Unhidden before the text is written: a role="alert" region only announces
    // content inserted while it is rendered. Both happen in the same task, so
    // the empty box never paints.
    error.hidden = false;
    error.textContent = message;
  };

  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    passwordInput.setAttribute("aria-invalid", "false");
    submit.disabled = true;
    submit.textContent = "Signing in…";

    try {
      // Bare fetch, not apiFetch(): a 401 here means "wrong password", not
      // "session expired". Latching it would re-enter renderLoginView()
      // mid-submit — wiping this error message and the typed value — and then
      // swallow every genuine expiry until the next successful login.
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: passwordInput.value,
          remember: rememberCheckbox.checked,
        }),
      });

      if (response.status === 429) {
        fail("Too many attempts — please wait a few minutes");
        return;
      }
      if (!response.ok) {
        fail("Invalid password");
        // Only this branch marks the field invalid: a throttled or failed
        // request says nothing about the value the user typed.
        passwordInput.setAttribute("aria-invalid", "true");
        // Pre-select the wrong password so retyping overwrites it.
        passwordInput.select();
        return;
      }

      gate.remove();
      for (const element of covered) {
        element.style.display = "";
        element.removeAttribute("inert");
      }
      onSuccess();
    } catch {
      fail("Network error — please try again");
    } finally {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });
}
