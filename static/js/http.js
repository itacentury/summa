/**
 * Single entry point for API requests, so a rejected session is noticed
 * wherever it happens.
 *
 * The login gate has to be able to come back: a cookie can expire, or the
 * server can be restarted with a new secret. Detecting that per call site would
 * mean the gate only reappears if the right request happens to fire, so every
 * request goes through one wrapper that latches the first 401 and notifies the
 * entry point once.
 */

/** Set once a 401 is seen, so concurrent requests raise the gate only once. */
let sessionExpired = false;

const listeners = new Set();

/**
 * Register a callback for the moment the session is rejected.
 *
 * @param {() => void} listener - Called once per expiry, not once per request.
 * @returns {void}
 */
export function onAuthExpired(listener) {
  listeners.add(listener);
}

/**
 * Re-arm the detector after a successful re-login.
 *
 * @returns {void}
 */
export function clearAuthExpired() {
  sessionExpired = false;
}

/**
 * Fetch an API endpoint, reporting a rejected session centrally.
 *
 * Options are passed through untouched (`signal` included) and errors are
 * rethrown, so callers keep their own abort handling and error reporting.
 *
 * @param {string} url - Request URL.
 * @param {RequestInit} [options] - Fetch options.
 * @returns {Promise<Response>}
 */
export async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401 && !sessionExpired) {
    sessionExpired = true;
    for (const listener of listeners) listener();
  }
  return response;
}
