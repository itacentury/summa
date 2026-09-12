import { beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse } from "./helpers.js";

/** Import http.js fresh, since the expiry latch is module state. */
const loadHttp = async () => {
  vi.resetModules();
  return import("../../static/js/http.js");
};

beforeEach(() => {
  global.fetch = vi.fn();
});

describe("apiFetch", () => {
  it("passes the request through untouched", async () => {
    const { apiFetch } = await loadHttp();
    const response = jsonResponse({ ok: true });
    global.fetch.mockResolvedValue(response);
    const signal = AbortSignal.abort();

    await expect(
      apiFetch("/api/stats", { method: "POST", signal }),
    ).resolves.toBe(response);
    expect(global.fetch).toHaveBeenCalledWith("/api/stats", {
      method: "POST",
      signal,
    });
  });

  it("returns the 401 to the caller rather than swallowing it", async () => {
    const { apiFetch, onAuthExpired } = await loadHttp();
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 401 }),
    );
    onAuthExpired(vi.fn());

    const response = await apiFetch("/api/invoices");

    expect(response.status).toBe(401);
  });

  it("rethrows a network error so callers keep their own handling", async () => {
    const { apiFetch } = await loadHttp();
    global.fetch.mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(apiFetch("/api/invoices")).rejects.toThrow("aborted");
  });

  it("raises the gate once for concurrent rejections", async () => {
    // Several requests can be in flight when a cookie expires; each notifying
    // separately would stack a login gate per request.
    const { apiFetch, onAuthExpired } = await loadHttp();
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 401 }),
    );
    const expired = vi.fn();
    onAuthExpired(expired);

    await Promise.all([
      apiFetch("/api/invoices"),
      apiFetch("/api/stores"),
      apiFetch("/api/categories"),
    ]);

    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("notifies every registered listener", async () => {
    const { apiFetch, onAuthExpired } = await loadHttp();
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 401 }),
    );
    const first = vi.fn();
    const second = vi.fn();
    onAuthExpired(first);
    onAuthExpired(second);

    await apiFetch("/api/invoices");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for responses that are merely unsuccessful", async () => {
    const { apiFetch, onAuthExpired } = await loadHttp();
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 500 }),
    );
    const expired = vi.fn();
    onAuthExpired(expired);

    await apiFetch("/api/invoices");

    expect(expired).not.toHaveBeenCalled();
  });

  it("re-arms after a successful re-login", async () => {
    const { apiFetch, clearAuthExpired, onAuthExpired } = await loadHttp();
    global.fetch.mockResolvedValue(
      jsonResponse({}, { ok: false, status: 401 }),
    );
    const expired = vi.fn();
    onAuthExpired(expired);

    await apiFetch("/api/invoices");
    clearAuthExpired();
    await apiFetch("/api/invoices");

    expect(expired).toHaveBeenCalledTimes(2);
  });
});
