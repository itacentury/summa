import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCategoryBadge,
  capAtToday,
  categoryColorVar,
  CHART_PALETTE_SIZE,
  chartColors,
  dateToIso,
  debounce,
  escapeHtml,
  formatCurrency,
  formatDate,
  formatDateShort,
  isFutureIsoDate,
  todayIso,
  withBusyButton,
  withEuro,
} from "../../static/js/dom.js";
import { applyChartTokens, dayOffset } from "./helpers.js";

describe("chartColors", () => {
  it("reads the palette from the --chart-N tokens, in order", () => {
    const tokens = applyChartTokens();

    expect(tokens).toHaveLength(CHART_PALETTE_SIZE);
    expect(chartColors()).toEqual(tokens);
  });
});

describe("formatDate / formatDateShort", () => {
  it("renders a bare ISO day as DD/MM/YYYY", () => {
    expect(formatDate("2024-03-01")).toBe("01/03/2024");
  });

  it("renders the compact DD/MM variant", () => {
    expect(formatDateShort("2024-03-01")).toBe("01/03");
  });

  // The parse-in-local-time trick exists to stop a date-only string (parsed as
  // UTC midnight) from rendering as the previous day in negative-offset zones.
  // With TZ pinned to Europe/Berlin (UTC+1/+2) a naive UTC parse would still
  // land on the same day, so assert the day component directly instead.
  it("keeps the calendar day (no UTC off-by-one shift)", () => {
    expect(formatDate("2024-01-01").startsWith("01/01")).toBe(true);
    expect(formatDate("2024-12-31").startsWith("31/12")).toBe(true);
  });

  it("returns an empty string for falsy input", () => {
    expect(formatDate("")).toBe("");
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDateShort("")).toBe("");
  });

  it("falls back to the permissive parser for datetime strings", () => {
    expect(formatDate("2024-03-01T12:00:00")).toBe("01/03/2024");
  });
});

describe("dateToIso / todayIso", () => {
  it("formats a Date as a local YYYY-MM-DD day", () => {
    // Local noon can't be pushed across a day boundary by the +1/+2 Berlin
    // offset, so this isolates the local-vs-UTC formatting choice.
    expect(dateToIso(new Date(2024, 2, 1, 12, 0, 0))).toBe("2024-03-01");
  });

  it("pads single-digit months and days", () => {
    expect(dateToIso(new Date(2024, 0, 5, 12, 0, 0))).toBe("2024-01-05");
  });

  it("returns today as a valid ISO day", () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("isFutureIsoDate", () => {
  it("accepts today — the day the picker previously greyed out", () => {
    expect(isFutureIsoDate(todayIso())).toBe(false);
  });

  it("accepts past days", () => {
    expect(isFutureIsoDate(dayOffset(-1))).toBe(false);
    expect(isFutureIsoDate("2024-03-01")).toBe(false);
  });

  it("rejects future days", () => {
    expect(isFutureIsoDate(dayOffset(1))).toBe(true);
    expect(isFutureIsoDate(dayOffset(400))).toBe(true);
  });

  it("treats an empty value as not future", () => {
    expect(isFutureIsoDate("")).toBe(false);
  });

  // A date field accepts 5+ digit years, which a plain string comparison sorts
  // below a 4-digit year ("1" < "2") and would wrongly call past.
  it("rejects years past 9999", () => {
    expect(isFutureIsoDate("10000-01-01")).toBe(true);
    expect(isFutureIsoDate("99999-12-31")).toBe(true);
    expect(isFutureIsoDate("275760-09-13")).toBe(true);
    expect(isFutureIsoDate("10000-01-01T00:00")).toBe(true);
    expect(isFutureIsoDate("010000-01-01")).toBe(true);
  });

  // A zero-padded year is not past 9999; the backend keeps its non-ISO
  // tolerance for it, so the client must not call it future either.
  it("tolerates a zero-padded year, like the backend", () => {
    expect(isFutureIsoDate("02026-01-01")).toBe(false);
  });

  // A datetime string sorts above the bare day it falls on, so today with a
  // time would read as future unless the day part is compared on its own —
  // which is what the backend's `date_value[:10]` does.
  it("compares only the day part of a datetime string", () => {
    expect(isFutureIsoDate(`${todayIso()}T10:00`)).toBe(false);
    expect(isFutureIsoDate(`${todayIso()}T23:59:59`)).toBe(false);
    expect(isFutureIsoDate(`${dayOffset(1)}T00:00`)).toBe(true);
  });
});

describe("capAtToday", () => {
  const ANDROID_FIREFOX =
    "Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0";
  const DESKTOP_FIREFOX =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0";
  const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36";

  const capWithUserAgent = (userAgent) => {
    vi.stubGlobal("navigator", { userAgent });
    const input = document.createElement("input");
    input.type = "date";
    capAtToday(input);
    return input.max;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caps at today on an ordinary browser", () => {
    expect(capWithUserAgent(DESKTOP_FIREFOX)).toBe(todayIso());
    expect(capWithUserAgent(ANDROID_CHROME)).toBe(todayIso());
  });

  // Firefox for Android greys out the `max` day itself, so capping at today
  // would make today unpickable — cap a day later there.
  it("caps at tomorrow on Firefox for Android", () => {
    expect(capWithUserAgent(ANDROID_FIREFOX)).toBe(dayOffset(1));
  });
});

describe("escapeHtml", () => {
  it("escapes all five significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("escapes ampersands first so entities are not double-encoded", () => {
    // A naive order would turn "<" into "&lt;" and then re-escape the "&".
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("returns an empty string for null and undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("stringifies non-string input", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(0)).toBe("0");
  });
});

describe("withBusyButton", () => {
  it("shows a disabled spinner while the task runs", async () => {
    const button = document.createElement("button");
    button.textContent = "Save";
    let during = null;

    const result = await withBusyButton(button, async () => {
      during = { html: button.innerHTML, disabled: button.disabled };
      return 7;
    });

    expect(during).toEqual({
      html: '<div class="spinner"></div>',
      disabled: true,
    });
    expect(result).toBe(7);
    expect(button.textContent).toBe("Save");
    expect(button.disabled).toBe(false);
  });

  it("restores the button when the task throws", async () => {
    const button = document.createElement("button");
    button.textContent = "Save";

    await expect(
      withBusyButton(button, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(button.textContent).toBe("Save");
    expect(button.disabled).toBe(false);
  });
});

describe("formatCurrency", () => {
  it("always renders exactly two decimals", () => {
    expect(formatCurrency(5)).toBe("5.00");
    expect(formatCurrency(5.1)).toBe("5.10");
  });

  it("rounds to two decimals", () => {
    expect(formatCurrency(1.005)).toBe("1.00");
    expect(formatCurrency(1.006)).toBe("1.01");
  });

  it("accepts numeric strings", () => {
    expect(formatCurrency("12.3")).toBe("12.30");
  });

  it("handles zero and negatives", () => {
    expect(formatCurrency(0)).toBe("0.00");
    expect(formatCurrency(-4.2)).toBe("-4.20");
  });
});

describe("withEuro", () => {
  it("puts the symbol behind the amount, joined by a non-breaking space", () => {
    expect(withEuro(formatCurrency(3.5))).toBe("3.50 €");
  });
});

describe("categoryColorVar / applyCategoryBadge", () => {
  it("maps known categories to their fixed --cat slug", () => {
    expect(categoryColorVar("Lebensmittel")).toBe("var(--cat-lebensmittel)");
    expect(categoryColorVar("Technik")).toBe("var(--cat-technik)");
  });

  it("folds umlaut categories onto the baecker slug", () => {
    expect(categoryColorVar("Bäcker")).toBe("var(--cat-baecker)");
    expect(categoryColorVar("bäckerei")).toBe("var(--cat-baecker)");
    expect(categoryColorVar("Restaurant")).toBe("var(--cat-baecker)");
  });

  it("is case- and whitespace-insensitive for known categories", () => {
    expect(categoryColorVar("  SPORT  ")).toBe("var(--cat-sport)");
  });

  it("hashes unknown categories deterministically onto --chart-1..8", () => {
    const first = categoryColorVar("Nonexistent Shop");
    const second = categoryColorVar("Nonexistent Shop");
    expect(first).toBe(second);
    expect(first).toMatch(/^var\(--chart-[1-8]\)$/);
  });

  it("gives the same unknown category the same color regardless of case", () => {
    expect(categoryColorVar("Gadgets")).toBe(categoryColorVar("gadgets"));
  });

  it("paints both background and text onto an element", () => {
    const element = document.createElement("span");
    applyCategoryBadge(element, "Technik");
    expect(element.style.background).toBe("var(--cat-technik)");
    expect(element.style.color).toBe("var(--cat-technik-text)");
  });
});

describe("debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the function only once after the quiet period", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, 300);

    debounced();
    debounced();
    debounced();
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("resets the timer on each call and forwards the latest arguments", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, 300);

    debounced("a");
    vi.advanceTimersByTime(200);
    debounced("b");
    vi.advanceTimersByTime(200);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("b");
  });
});
