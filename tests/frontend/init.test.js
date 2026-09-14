import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Importing app.js *is* the test: module scripts run after parsing, so app.js
 * boots at import time unless document.readyState is still "loading" — and it
 * never is under happy-dom. The service-worker block is skipped for free
 * because happy-dom's navigator has no `serviceWorker`.
 *
 * init() now sits behind the auth check, so the import alone is not enough:
 * runInit() also drains the microtask queue that getAuthStatus() resolves on.
 *
 * Every feature module is replaced with a spy, so what is under test is purely
 * init()'s control flow: one failing wiring step must not stop the others.
 */

const steps = vi.hoisted(() => {
  const named = (name) => {
    const spy = vi.fn();
    // init() labels a failure with `step.name`, and vi.fn() reports "spy".
    Object.defineProperty(spy, "name", { value: name });
    return spy;
  };
  const names = [
    "setupComboboxes",
    "applyFilter",
    "refreshAllData",
    "setupFilterListeners",
    "setupModalListeners",
    "setupSettingsListeners",
    "setupInvoiceListListeners",
    "setupPaginationListeners",
    "setupPageSizeListeners",
    "setupBulkListeners",
    "setupStatsListeners",
    "setupViewListeners",
    "restorePortfolioPrefs",
    "setupPortfolioListeners",
    "setupImportListeners",
    "setupCategorizeListeners",
    "initToastListeners",
    "setupKeyboardListeners",
    "setupDrawerListeners",
    "setupSheetGestures",
    "setupViewportListeners",
    "updateFilterBadge",
    "loadInvoices",
    "renderLoginView",
    "setupSignOut",
  ];
  return Object.fromEntries(names.map((name) => [name, named(name)]));
});

vi.mock("../../static/js/filters.js", () => ({
  applyFilter: steps.applyFilter,
  setupFilterListeners: steps.setupFilterListeners,
  updateFilterBadge: steps.updateFilterBadge,
}));
vi.mock("../../static/js/api.js", () => ({
  loadInvoices: steps.loadInvoices,
  refreshAllData: steps.refreshAllData,
  setupPaginationListeners: steps.setupPaginationListeners,
}));
vi.mock("../../static/js/modals.js", () => ({
  setupModalListeners: steps.setupModalListeners,
}));
vi.mock("../../static/js/settings.js", () => ({
  setupSettingsListeners: steps.setupSettingsListeners,
}));
vi.mock("../../static/js/render.js", () => ({
  setupInvoiceListListeners: steps.setupInvoiceListListeners,
}));
vi.mock("../../static/js/bulk.js", () => ({
  setupBulkListeners: steps.setupBulkListeners,
}));
vi.mock("../../static/js/stats.js", () => ({
  setupStatsListeners: steps.setupStatsListeners,
}));
vi.mock("../../static/js/views.js", () => ({
  setupViewListeners: steps.setupViewListeners,
}));
vi.mock("../../static/js/portfolio.js", () => ({
  restorePortfolioPrefs: steps.restorePortfolioPrefs,
  setupPortfolioListeners: steps.setupPortfolioListeners,
}));
vi.mock("../../static/js/import.js", () => ({
  setupImportListeners: steps.setupImportListeners,
}));
vi.mock("../../static/js/categorize.js", () => ({
  setupCategorizeListeners: steps.setupCategorizeListeners,
}));
vi.mock("../../static/js/combobox.js", () => ({
  setupComboboxes: steps.setupComboboxes,
}));
vi.mock("../../static/js/toast.js", () => ({
  initToastListeners: steps.initToastListeners,
}));
vi.mock("../../static/js/keyboard.js", () => ({
  setupKeyboardListeners: steps.setupKeyboardListeners,
}));
vi.mock("../../static/js/drawer.js", () => ({
  setupDrawerListeners: steps.setupDrawerListeners,
}));
vi.mock("../../static/js/sheet.js", () => ({
  setupSheetGestures: steps.setupSheetGestures,
}));
vi.mock("../../static/js/viewport.js", () => ({
  setupViewportListeners: steps.setupViewportListeners,
}));
vi.mock("../../static/js/pagesize.js", () => ({
  setupPageSizeListeners: steps.setupPageSizeListeners,
}));

// Authed by default, so the existing cases exercise init() unchanged. The boot
// gate itself is covered in its own describe block below.
const authStatus = vi.hoisted(() => ({
  value: { authed: true, enabled: false },
}));
vi.mock("../../static/js/auth.js", () => ({
  getAuthStatus: () => Promise.resolve(authStatus.value),
  renderLoginView: steps.renderLoginView,
  setupSignOut: steps.setupSignOut,
}));

// Ordered as init() runs them: the pre-load block first, then the wiring loop.
const PRE_LOAD_STEPS = ["setupComboboxes", "applyFilter", "refreshAllData"];
const WIRING_STEPS = [
  "setupFilterListeners",
  "setupModalListeners",
  "setupSettingsListeners",
  "setupInvoiceListListeners",
  "setupPaginationListeners",
  "setupPageSizeListeners",
  "setupBulkListeners",
  "setupStatsListeners",
  "setupViewListeners",
  "setupPortfolioListeners",
  "setupImportListeners",
  "setupCategorizeListeners",
  "initToastListeners",
  "setupKeyboardListeners",
  "setupDrawerListeners",
  "setupSheetGestures",
  "setupViewportListeners",
];
const ALL_STEPS = [...PRE_LOAD_STEPS, ...WIRING_STEPS];

let consoleError;

/** Import app.js fresh, so boot() runs again against the current spy setup. */
const runInit = async () => {
  vi.resetModules();
  await import("../../static/js/app.js");
  // boot() only reaches init() after getAuthStatus() settles.
  await vi.waitFor(() => {
    if (
      !steps.setupComboboxes.mock.calls.length &&
      !steps.renderLoginView.mock.calls.length
    ) {
      throw new Error("boot has not settled");
    }
  });
};

/** Names of the steps that ran, so a failure names the missing wiring. */
const stepsThatRan = (names = ALL_STEPS) =>
  names.filter((name) => steps[name].mock.calls.length > 0);

/** Position of a step's first call in the global invocation sequence. */
const callOrder = (name) => steps[name].mock.invocationCallOrder[0];

/** Make a step throw, the way a missing DOM element would. */
const breakStep = (name) => {
  steps[name].mockImplementation(() => {
    throw new Error(`${name} exploded`);
  });
};

const loggedLabels = () =>
  consoleError.mock.calls.map(([message]) => String(message));

beforeEach(() => {
  authStatus.value = { authed: true, enabled: false };
  for (const step of Object.values(steps)) step.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

describe("init", () => {
  it("runs every wiring step exactly once", async () => {
    await runInit();
    for (const name of ALL_STEPS) {
      expect(steps[name], name).toHaveBeenCalledTimes(1);
    }
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("instantiates the comboboxes before the first data load", async () => {
    // Load-bearing, not incidental: refreshAllData() fans out to loadStores()
    // and loadCategories(), which feed their options into the combobox
    // instances via getCombobox() — and skip that silently when none exists
    // yet. stepsThatRan() reports the declared order of ALL_STEPS, not the
    // observed one, so only the invocation order catches a reordering.
    await runInit();

    expect(callOrder("setupComboboxes")).toBeLessThan(
      callOrder("refreshAllData"),
    );
  });

  it("keeps wiring the remaining steps when one throws", async () => {
    // The regression itself: setupFilterListeners() threw on a missing,
    // conditionally rendered element and took the sidebar nav, the "+" button,
    // Import, the modals, the keyboard shortcuts and the drawer down with it.
    breakStep("setupFilterListeners");
    await runInit();

    const survivors = WIRING_STEPS.filter(
      (name) => name !== "setupFilterListeners",
    );
    expect(stepsThatRan(survivors)).toEqual(survivors);
    for (const name of survivors) {
      expect(steps[name], name).toHaveBeenCalledTimes(1);
    }
  });

  it("names the failing step in the console", async () => {
    breakStep("setupFilterListeners");
    await runInit();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(loggedLabels()[0]).toMatch(/^\[init\] setupFilterListeners failed:/);
  });

  it("isolates a failure in the pre-load block too", async () => {
    // setupComboboxes runs before the data load, so an unguarded throw there
    // would cost every later step, not just the comboboxes.
    breakStep("setupComboboxes");
    await runInit();

    const survivors = ALL_STEPS.filter((name) => name !== "setupComboboxes");
    expect(stepsThatRan(survivors)).toEqual(survivors);
    expect(loggedLabels()[0]).toMatch(/^\[init\] setupComboboxes failed:/);
  });

  it("survives a localStorage that throws", async () => {
    // Blocked storage (Safari private mode, cookies disabled) makes getItem
    // throw rather than return null. restorePageSize is init()'s first
    // statement, so an unguarded throw there costs every step — the same bug
    // class as above, reached without a missing element.
    //
    // Replacing the whole global rather than spying on Storage.prototype:
    // happy-dom copies each prototype method onto the localStorage instance as
    // a bound own property the first time it is read, so a prototype spy is
    // invisible to every later call — and its restore is swallowed by the
    // instance's Proxy, leaking a throwing getItem into the rest of the file.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    try {
      await runInit();

      expect(stepsThatRan()).toEqual(ALL_STEPS);
      expect(loggedLabels()).toEqual([
        expect.stringMatching(/^\[init\] restorePageSize failed:/),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("isolates each failure independently, not just the first", async () => {
    breakStep("setupModalListeners");
    breakStep("setupDrawerListeners");
    await runInit();

    const survivors = ALL_STEPS.filter(
      (name) =>
        name !== "setupModalListeners" && name !== "setupDrawerListeners",
    );
    expect(stepsThatRan(survivors)).toEqual(survivors);
    expect(loggedLabels()).toEqual([
      expect.stringMatching(/^\[init\] setupModalListeners failed:/),
      expect.stringMatching(/^\[init\] setupDrawerListeners failed:/),
    ]);
  });
});

describe("boot gate", () => {
  it("starts the app directly when the session is valid", async () => {
    await runInit();

    expect(steps.renderLoginView).not.toHaveBeenCalled();
    expect(steps.setupComboboxes).toHaveBeenCalledTimes(1);
  });

  it("shows the login view instead of touching the API when unauthenticated", async () => {
    // The point of the gate: nothing that talks to the API may run first.
    authStatus.value = { authed: false, enabled: true };
    await runInit();

    expect(steps.renderLoginView).toHaveBeenCalledTimes(1);
    expect(stepsThatRan()).toEqual([]);
  });

  it("wires the app exactly once when login succeeds", async () => {
    // A re-login after an expired session must not double-wire the listeners,
    // which would fire every handler twice.
    authStatus.value = { authed: false, enabled: true };
    await runInit();

    const [onSuccess] = steps.renderLoginView.mock.calls[0];
    onSuccess();
    onSuccess();

    expect(stepsThatRan()).toEqual(ALL_STEPS);
    for (const name of ALL_STEPS) {
      expect(steps[name], name).toHaveBeenCalledTimes(1);
    }
  });
});

describe("session expiry", () => {
  /**
   * Drive a 401 through the real http.js, the way an expired cookie would.
   *
   * http.js is deliberately not mocked in this file, and no resetModules() runs
   * between runInit() and this import, so app.js and the test share one module
   * instance — including the latch that raises the gate exactly once.
   */
  const expireSession = async () => {
    const { apiFetch } = await import("../../static/js/http.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await apiFetch("/api/invoices");
  };

  /** Re-login, by calling back the way the login form does. */
  const logBackIn = () => steps.renderLoginView.mock.calls[0][0]();

  it("raises the login gate when a session expires mid-use", async () => {
    await runInit();

    await expireSession();

    expect(steps.renderLoginView).toHaveBeenCalledTimes(1);
  });

  it("reloads the data without re-wiring the listeners on re-login", async () => {
    // The expiry path bypasses init() on purpose: its listeners are still wired
    // from the first start, and wiring them again fires every handler twice.
    await runInit();
    await expireSession();

    logBackIn();

    expect(steps.refreshAllData).toHaveBeenCalledTimes(2);
    for (const name of WIRING_STEPS) {
      expect(steps[name], name).toHaveBeenCalledTimes(1);
    }
  });

  it("re-arms the gate for the next expiry", async () => {
    // clearAuthExpired() resets the latch. Without it the first expiry would be
    // the only one ever shown, and the second would leave the app on stale data.
    await runInit();
    await expireSession();
    logBackIn();

    await expireSession();

    expect(steps.renderLoginView).toHaveBeenCalledTimes(2);
  });
});
