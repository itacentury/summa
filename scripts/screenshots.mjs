#!/usr/bin/env node
/**
 * Capture the documented UI surfaces into docs/screenshots/.
 *
 * Deliberately a small, curated set: one screenshot per surface that shows
 * something the others don't. Adding a step here means adding a file to the
 * index in docs/screenshots/README.md.
 *
 * Playwright is deliberately not a dependency of this repo (CI's `frontend` job
 * installs from package.json and has no use for a browser). Install it once
 * somewhere outside the repo and point NODE_PATH at it:
 *
 *   mkdir -p /tmp/summa-pw && cd /tmp/summa-pw && npm init -y && npm i playwright
 *   npx playwright install chromium
 *   NODE_PATH=/tmp/summa-pw/node_modules node scripts/screenshots.mjs
 *
 * The run starts its own dev server against a throwaway database, so the
 * repository's own invoices.db is never touched. It aborts up front if port 8000
 * is already taken or the database it talks to turns out not to be empty, rather
 * than screenshot whatever process happens to be listening.
 *
 * Screenshots are captured into a work directory; the committed PNGs are only
 * replaced once every surface has succeeded, so a failed run leaves the working
 * tree untouched.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "docs", "screenshots");
const WORK_DIR = join(tmpdir(), "summa-screenshots");
const SHOT_DIR = join(WORK_DIR, "shots");
const BASE_URL = "http://127.0.0.1:8000";
const DEMO_PASSWORD = "demo-password";

const DESKTOP = { name: "desktop", width: 1280, height: 900 };
const MOBILE = { name: "mobile", width: 390, height: 844 };

/** Selector for the modal overlays, keyed by the surface they belong to. */
const MODAL = {
  add: '[data-el="add-invoice-modal"]',
  import: '[data-el="import-modal"]',
  categorize: '[data-el="categorize-modal"]',
};

const failures = [];
let captured = 0;

/* ------------------------------------------------------------------ utils */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve Playwright, which lives outside this repo (see the header comment).
 */
const loadPlaywright = async () => {
  // A CommonJS package imported by file URL exposes its exports on `default`.
  const unwrap = (module) => module.chromium ?? module.default?.chromium;

  try {
    const chromium = unwrap(await import("playwright"));
    if (chromium) return chromium;
  } catch {
    // Not resolvable from the repo; fall back to NODE_PATH below.
  }

  const require = createRequire(import.meta.url);
  for (const root of (process.env.NODE_PATH ?? "").split(":").filter(Boolean)) {
    try {
      const entry = require.resolve("playwright", { paths: [root] });
      const chromium = unwrap(await import(pathToFileURL(entry).href));
      if (chromium) return chromium;
    } catch {
      // Try the next NODE_PATH entry.
    }
  }
  throw new Error(
    "Playwright not found. See the header of this file for how to install it.",
  );
};

/**
 * Refuse to run while something else is listening, because the readiness probe
 * below cannot tell a foreign server apart from our own — and a foreign one
 * would be serving the real database.
 */
const assertPortFree = async () => {
  try {
    await fetch(`${BASE_URL}/`);
  } catch {
    return;
  }
  throw new Error(
    `Something is already listening on ${BASE_URL} — stop your dev server and re-run.`,
  );
};

/**
 * Spawn the dev server and resolve once it answers, or reject on timeout.
 */
const startServer = async (env) => {
  const child = spawn("uv", ["run", "python", "-m", "summa"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));

  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early:\n${log}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`);
      if (response.ok) return child;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  child.kill("SIGTERM");
  throw new Error(`Server did not become ready:\n${log}`);
};

const stopServer = async (child) => {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  // The port lingers for a moment after the process is gone.
  await sleep(500);
};

/**
 * Shift every demo date forward by whole months so the newest invoice lands in
 * the current month. The committed dates are absolute — which keeps the file a
 * directly importable sample — but the default "Month" filter would show an
 * empty list a few weeks after they were written.
 *
 * The newest demo invoice sits mid-month, so on an earlier day the aligned
 * shift would land in the future, which the API rejects. Those invoices are
 * rescaled into the part of the month that has already happened rather than
 * pushed back a further month — that would leave the default view empty — and
 * rather than clamped onto today, which would date a third of the list
 * identically in the screenshots.
 */
const shiftDatesToToday = (invoices) => {
  const parse = (iso) => iso.split("-").map(Number);
  const pad = (number) => String(number).padStart(2, "0");
  const today = new Date();
  const [newestYear, newestMonth] = parse(
    invoices
      .map((invoice) => invoice.date)
      .sort()
      .at(-1),
  );

  const shiftBy = (months) =>
    invoices.map((invoice) => {
      const [year, month, day] = parse(invoice.date);
      const target = new Date(Date.UTC(year, month - 1 + months, 1));
      const daysInMonth = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const shifted = new Date(
        Date.UTC(
          target.getUTCFullYear(),
          target.getUTCMonth(),
          Math.min(day, daysInMonth),
        ),
      );
      return { ...invoice, date: shifted.toISOString().slice(0, 10) };
    });

  const months =
    (today.getFullYear() - newestYear) * 12 +
    (today.getMonth() + 1 - newestMonth);
  const shifted = shiftBy(months);

  // Local getters throughout: `months` above is computed from the local date,
  // and the server validates against its own local `date.today()`. Deriving
  // the cutoff from toISOString() instead would disagree by a day for part of
  // every day outside UTC.
  const currentMonth = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
  const dayOfMonth = (invoice) => Number(invoice.date.slice(8));
  const inCurrentMonth = shifted.filter((invoice) =>
    invoice.date.startsWith(currentMonth),
  );
  const latestDay = Math.max(...inCurrentMonth.map(dayOfMonth));
  if (latestDay <= today.getDate()) return shifted;

  return shifted.map((invoice) => {
    if (!invoice.date.startsWith(currentMonth)) return invoice;
    const day = Math.round((dayOfMonth(invoice) * today.getDate()) / latestDay);
    return { ...invoice, date: `${currentMonth}-${pad(Math.max(1, day))}` };
  });
};

const seed = async () => {
  // Second line of defence behind assertPortFree(): a throwaway database is
  // always empty, a server we accidentally adopted never is.
  const existing = await (await fetch(`${BASE_URL}/api/invoices`)).json();
  if (existing.total_count !== 0) {
    throw new Error(
      `Expected an empty database, found ${existing.total_count} invoices — ` +
        "the run is talking to a server that is not its own.",
    );
  }

  const raw = JSON.parse(
    await readFile(join(REPO_ROOT, "scripts", "screenshot-data.json"), "utf8"),
  );
  const response = await fetch(`${BASE_URL}/api/invoices/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(shiftDatesToToday(raw)),
  });
  const result = await response.json();
  if (!response.ok || result.failed > 0) {
    throw new Error(`Seeding failed: ${JSON.stringify(result)}`);
  }
  console.log(`  seeded ${result.imported} invoices`);
};

/* ------------------------------------------------------------- page helpers */

/** Open a page with the app booted and the invoice list rendered. */
const openApp = async (context, { waitForList = true } = {}) => {
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  if (waitForList) {
    await page.waitForSelector(".invoice-item", { timeout: 15000 });
  }
  await page.waitForTimeout(400);
  return page;
};

/** Wait for a modal overlay to finish its open animation. */
const waitForModal = async (page, selector) => {
  await page.waitForSelector(`${selector}.active`, { timeout: 5000 });
  await page.waitForTimeout(500);
};

/** Reload back to the default view, so each step starts from a known state. */
const resetPage = async (page) => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".invoice-item", { timeout: 15000 });
  await page.waitForTimeout(400);
};

/** Switch views through the sidebar. */
const gotoView = async (page, view) => {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(700);
};

/**
 * Run one capture step in isolation: a failing surface is reported but never
 * aborts the whole run.
 *
 * Most steps reload the page first. Without that, one failure leaves the app
 * half-way through a flow (a modal open, the wrong view active) and every later
 * step in the same page fails too. Steps that deliberately continue from the
 * previous one pass `fresh: false`.
 */
const step = async (
  name,
  viewport,
  body,
  { page = null, fresh = true } = {},
) => {
  const file = join(SHOT_DIR, `${name}-${viewport.name}.png`);
  try {
    if (page && fresh) await resetPage(page);
    await body(file);
    captured += 1;
    console.log(`  ✓ ${name}-${viewport.name}`);
  } catch (error) {
    failures.push(`${name}-${viewport.name}: ${error.message.split("\n")[0]}`);
    console.log(`  ✗ ${name}-${viewport.name}`);
  }
};

/**
 * Run one capture group in isolation. `step()` only guards what happens after
 * the app is open; a group that fails before that — opening the page, reading a
 * fixture — would otherwise abort every later group with it.
 */
const group = async (name, body) => {
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error.message.split("\n")[0]}`);
    console.log(`  ✗ ${name} (group aborted)`);
  }
};

/* ----------------------------------------------------------- stub fixtures */

/**
 * Fixture for POST /api/invoices/categorize-suggest, shaped like the real
 * endpoint. Stubbed so the run needs no Anthropic API key and stays
 * deterministic. `total > count` also exercises the "First N of M" note.
 */
const categorizeFixture = (ids) => ({
  suggestions: [
    {
      invoice_id: ids[0],
      store: "Best Buy",
      total: 72.98,
      items: [
        { item_name: "USB-C hub 7-in-1", item_price: 59.99 },
        { item_name: "HDMI cable 2 m", item_price: 12.99 },
      ],
      category: "Electronics",
      is_new: false,
    },
    {
      invoice_id: ids[1],
      store: "CVS Pharmacy",
      total: 21.46,
      items: [
        { item_name: "Toothpaste 2-pack", item_price: 9.98 },
        { item_name: "Dental floss", item_price: 4.49 },
        { item_name: "Hand soap refill", item_price: 6.99 },
      ],
      category: "Personal Care",
      is_new: true,
    },
    {
      invoice_id: ids[2],
      store: "Blue Bottle Coffee",
      total: 9.2,
      items: [
        { item_name: "Pour over", item_price: 4.95 },
        { item_name: "Banana bread", item_price: 4.25 },
      ],
      category: "Dining",
      is_new: false,
    },
    {
      invoice_id: ids[3],
      store: "IKEA",
      total: 327.99,
      items: [
        { item_name: "MALM bed frame", item_price: 249.0 },
        { item_name: "Mattress protector", item_price: 29.99 },
        { item_name: "Bedside table", item_price: 49.0 },
      ],
      category: "Household",
      is_new: false,
    },
  ].slice(0, ids.length),
  count: Math.min(ids.length, 4),
  total: Math.min(ids.length, 4) + 3,
});

const stubCategorize = async (page) => {
  await page.route("**/api/invoices/categorize-suggest", async (route) => {
    const ids = JSON.parse(route.request().postData() ?? "{}").ids ?? [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(categorizeFixture(ids.slice(0, 4))),
    });
  });
};

/* --------------------------------------------------------------- captures */

const captureDesktop = async (context) => {
  const viewport = DESKTOP;
  const page = await openApp(context);
  const opts = { page };

  await step(
    "invoice-list-expanded",
    viewport,
    async (file) => {
      await page.locator(".invoice-header").first().click();
      await page.waitForSelector(".invoice-item.expanded .invoice-details");
      await page.waitForTimeout(500);
      await page.screenshot({ path: file });
    },
    opts,
  );

  await step(
    "stats",
    viewport,
    async (file) => {
      await gotoView(page, "stats");
      await page.waitForSelector('[data-el="category-legend"] *', {
        timeout: 8000,
      });
      await page.waitForTimeout(900);
      await page.screenshot({ path: file });
    },
    opts,
  );

  await step(
    "filter-panel",
    viewport,
    async (file) => {
      await page.locator('[data-el="filters-toggle"]').click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: file });
    },
    opts,
  );

  await step(
    "new-invoice-filled",
    viewport,
    async (file) => {
      await page.keyboard.press("n");
      await waitForModal(page, MODAL.add);
      await page.locator('[data-el="invoice-store"]').fill("Farmers Market");
      const rows = page.locator(".item-input-row");
      const fillItem = async (index, name, price) => {
        await rows.nth(index).locator(".item-name").fill(name);
        await rows.nth(index).locator(".item-price").fill(price);
      };
      await fillItem(0, "Heirloom tomatoes", "7.40");
      await page.locator('[data-action="add-item"]').click();
      await fillItem(1, "Farmhouse cheddar", "12.90");
      await page.locator('[data-action="add-item"]').click();
      await fillItem(2, "Wildflower honey", "9.50");
      await page.locator('[data-el="invoice-store"]').click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: file });
    },
    opts,
  );

  await step(
    "bulk-selection",
    viewport,
    async (file) => {
      for (const index of [0, 1, 2]) {
        // The real input is 0x0 and transparent; the visible target is the mark.
        await page
          .locator(".invoice-item")
          .nth(index)
          .locator(".invoice-checkbox .checkbox-mark")
          .click();
        await page.waitForTimeout(200);
      }
      await page.waitForSelector('[data-el="bulk-action-toolbar"].visible');
      await page.waitForTimeout(500);
      await page.screenshot({ path: file });
    },
    opts,
  );

  await page.close();
};

const captureCategorize = async (context) => {
  const page = await openApp(context);
  await stubCategorize(page);

  await step("categorize-row-expanded", DESKTOP, async (file) => {
    // The current month holds a single uncategorized invoice, which would make
    // for a one-row review list; "All" gives the suggestions their full set.
    await page.locator('.quick-filter-btn[data-filter="all"]').click();
    await page.waitForTimeout(800);
    await page.locator('[data-action="open-categorize"]').click();
    await waitForModal(page, MODAL.categorize);
    await page.waitForSelector(".categorize-row", { timeout: 10000 });
    await page.waitForTimeout(700);
    await page.locator('[data-action="toggle-items"]').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: file });
  });

  await page.close();
};

const captureImport = async (browser) => {
  const context = await browser.newContext({
    viewport: { width: DESKTOP.width, height: DESKTOP.height },
    deviceScaleFactor: 2,
  });
  const page = await openApp(context);
  const sample = await readFile(
    join(REPO_ROOT, "scripts", "screenshot-import-sample.json"),
    "utf8",
  );

  await step("import-empty", DESKTOP, async (file) => {
    await page.keyboard.press("i");
    await waitForModal(page, MODAL.import);
    await page.screenshot({ path: file });
  });

  await step("import-errors", DESKTOP, async (file) => {
    // Two of the sample's entries are invalid on purpose.
    await page.locator('[data-el="json-input"]').fill(sample);
    await page.waitForTimeout(500);
    await page.locator(`${MODAL.import} [data-action="import"]`).click();
    await page.waitForSelector('[data-el="import-errors"]:not([hidden])', {
      timeout: 10000,
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: file });
  });

  await page.close();
  await context.close();
};

const captureMobile = async (context) => {
  const viewport = MOBILE;
  const page = await openApp(context);

  await step(
    "invoice-list-expanded",
    viewport,
    async (file) => {
      await page.locator(".invoice-header").first().click();
      await page.waitForSelector(".invoice-item.expanded .invoice-details");
      await page.waitForTimeout(500);
      await page.screenshot({ path: file });
    },
    { page },
  );

  await step(
    "drawer",
    viewport,
    async (file) => {
      await page.locator('[data-el="drawer-toggle"]').click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: file });
    },
    { page },
  );

  await page.close();
};

const captureLogin = async (browser) => {
  const context = await browser.newContext({
    viewport: { width: DESKTOP.width, height: DESKTOP.height },
    deviceScaleFactor: 2,
  });

  await step("login", DESKTOP, async (file) => {
    const page = await openApp(context, { waitForList: false });
    await page.waitForSelector('[data-el="login-gate"]', { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: file });
    await page.close();
  });

  await context.close();
};

/**
 * Shrink the captured PNGs to a 256-colour palette. The UI is flat-coloured, so
 * the result is visually identical at roughly a third of the size, which is
 * worth having for images living in git. Skipped, with a note, when no such
 * tool is installed.
 */
const compress = async () => {
  const files = (await readdir(SHOT_DIR))
    .filter((name) => name.endsWith(".png"))
    .map((name) => join(SHOT_DIR, name));
  if (files.length === 0) return;

  const attempts = [
    [
      "pngquant",
      ["--force", "--skip-if-larger", "--ext", ".png", "--", ...files],
    ],
    ["oxipng", ["-o", "4", "--strip", "safe", "-q", ...files]],
    ["magick", ["mogrify", "-colors", "256", ...files]],
  ];
  for (const [tool, args] of attempts) {
    const succeeded = await new Promise((resolve) => {
      const child = spawn(tool, args, { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
    if (succeeded) {
      console.log(`\ncompressed with ${tool}`);
      return;
    }
  }
  console.log(
    "\nnote: install pngquant, oxipng or ImageMagick to shrink the PNGs",
  );
};

/* ------------------------------------------------------------------- main */

/**
 * Replace the committed PNGs with the ones just captured, so the folder holds
 * exactly the set this script produces and never a stale file from a surface
 * that was dropped.
 *
 * Runs last, and only for a run in which every surface succeeded: emptying the
 * folder up front would leave a failed run with nothing but a dirty tree.
 * Copied rather than renamed — the work directory sits under the system temp
 * directory, which is routinely a different filesystem.
 */
const publish = async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const stale = (await readdir(OUT_DIR)).filter((name) =>
    name.endsWith(".png"),
  );
  for (const name of stale) await rm(join(OUT_DIR, name));

  const shots = (await readdir(SHOT_DIR)).filter((name) =>
    name.endsWith(".png"),
  );
  for (const name of shots) {
    await copyFile(join(SHOT_DIR, name), join(OUT_DIR, name));
  }
};

const newContext = async (browser, viewport) =>
  browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
  });

const main = async () => {
  const chromium = await loadPlaywright();
  await assertPortFree();

  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch();

  // Pass A: unauthenticated, with the AI UI rendered (no key — the suggestion
  // endpoint is stubbed per page).
  console.log("Pass A — main application");
  let server = await startServer({
    DATABASE_PATH: join(WORK_DIR, "invoices.db"),
    ENABLE_AI_SUGGESTIONS: "1",
    AUTH_ENABLED: "0",
  });
  try {
    await seed();

    console.log(`\ndesktop (${DESKTOP.width}x${DESKTOP.height})`);
    const desktop = await newContext(browser, DESKTOP);
    await group("desktop", () => captureDesktop(desktop));
    await group("categorize", () => captureCategorize(desktop));
    await desktop.close();

    console.log(`\nmobile (${MOBILE.width}x${MOBILE.height})`);
    const mobile = await newContext(browser, MOBILE);
    await group("mobile", () => captureMobile(mobile));
    await mobile.close();

    // Last: the sample import inserts rows, which would change every list above.
    console.log("\nimport flow");
    await group("import", () => captureImport(browser));
  } finally {
    await stopServer(server);
  }

  // Pass B: the password gate, which only exists with AUTH_ENABLED.
  console.log("\nPass B — login gate");
  const hash = await new Promise((resolve, reject) => {
    const child = spawn(
      "uv",
      ["run", "python", "-m", "summa.hashpw", DEMO_PASSWORD],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error("hashpw failed")),
    );
  });

  server = await startServer({
    // Same database as pass A, so the gate guards the demo data.
    DATABASE_PATH: join(WORK_DIR, "invoices.db"),
    AUTH_ENABLED: "1",
    AUTH_PASSWORD_HASH: hash,
    SESSION_SECRET: "screenshot-run-secret",
    // A Secure cookie is dropped over plain http: login would look like it
    // succeeded and every later request would be rejected.
    COOKIE_SECURE: "0",
    ENABLE_AI_SUGGESTIONS: "0",
  });
  try {
    await captureLogin(browser);
  } finally {
    await stopServer(server);
  }

  await browser.close();
  await compress();

  if (failures.length > 0) {
    console.error(`\n${failures.length} failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      `\ndocs/screenshots/ left untouched; the ${captured} captured so far are in ${SHOT_DIR}`,
    );
    process.exitCode = 1;
    return;
  }

  await publish();
  console.log(`\n${captured} screenshots written to docs/screenshots/`);
};

await main();
