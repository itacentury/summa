/**
 * The Settings dialog's Portfolio section: the two Manage rows and their
 * summaries, plus the benchmark fallback select.
 *
 * Everything here reads `GET /api/portfolio?range=max` rather than the snapshot
 * prefill: that is the only endpoint carrying closed positions, and the
 * Positions editor exists to reopen them.
 */

import { apiFetch } from "./http.js";
import { showErrorToast, showNoticeToast } from "./toast.js";
import { escapeHtml } from "./dom.js";
import { loadPortfolio } from "./portfolio.js";
import { openManageModal } from "./portfolio-manage.js";

// The flagged position, remembered because clearing the select has to unflag a
// row the payload no longer names.
let fallbackId = null;

/**
 * The section's hooks, or `null` when it is not on the page.
 *
 * The guard matters: the dialog is wired before anything portfolio-related is
 * known to exist, and a settings fixture without these rows must not fetch.
 */
function settingsElements() {
  const depots = document.querySelector('[data-el="settings-depots-sub"]');
  if (!depots) return null;
  return {
    depots,
    positions: document.querySelector('[data-el="settings-positions-sub"]'),
    benchmark: document.querySelector('[data-el="settings-benchmark"]'),
  };
}

function allPositions(depots) {
  return depots.flatMap((depot) => depot.positions);
}

function depotsSummary(depots) {
  if (!depots.length) return "None yet";
  return depots.map((depot) => depot.name).join(" · ");
}

function positionsSummary(depots) {
  const positions = allPositions(depots);
  const closed = positions.filter((position) => position.closed_at).length;
  return `${positions.length - closed} active · ${closed} closed · type, currency, depot`;
}

/**
 * Fill the select with the active positions, preselecting the flagged one.
 *
 * A closed position is left out: it stops contributing a value the week it is
 * sold, so a benchmark drawn from it would flatline from there on.
 */
function renderBenchmarkOptions(select, depots) {
  const active = allPositions(depots).filter((position) => !position.closed_at);
  fallbackId =
    active.find((position) => position.is_benchmark_fallback)?.id ?? null;
  const options = active
    .map(
      (position) =>
        `<option value="${position.id}">${escapeHtml(position.name)}</option>`,
    )
    .join("");
  select.innerHTML = `<option value="">None</option>${options}`;
  select.value = fallbackId === null ? "" : String(fallbackId);
}

/** Refill the section. Reports its own failures; callers need not await it. */
export async function refreshPortfolioSettings() {
  const elements = settingsElements();
  if (!elements) return;

  try {
    const response = await apiFetch("/api/portfolio?range=max");
    if (!response.ok) {
      throw new Error(`Portfolio settings failed: ${response.status}`);
    }
    const payload = await response.json();
    elements.depots.textContent = depotsSummary(payload.depots);
    elements.positions.textContent = positionsSummary(payload.depots);
    renderBenchmarkOptions(elements.benchmark, payload.depots);
  } catch (error) {
    console.error("Error loading portfolio settings:", error);
  }
}

/**
 * Move the benchmark fallback flag, or clear it.
 *
 * Only ever one PATCH: the server clears the other flags itself, so setting the
 * new position is the whole operation.
 */
async function setFallback(value) {
  const selected = value === "" ? null : Number(value);
  const target = selected ?? fallbackId;
  if (target === null) return;

  const previous = fallbackId;
  try {
    const response = await apiFetch(`/api/portfolio/positions/${target}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_benchmark_fallback: selected !== null }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      showErrorToast(payload.error ?? "Failed to set the benchmark");
      settingsElements().benchmark.value =
        previous === null ? "" : String(previous);
      return;
    }

    fallbackId = selected;
    showNoticeToast("Benchmark updated");
    // The list behind the dialog carries the badge on the flagged row.
    await loadPortfolio();
  } catch (error) {
    console.error("Error setting the benchmark:", error);
    showErrorToast("Failed to set the benchmark");
  }
}

/** Wire the two Manage buttons and the benchmark select. */
export function setupPortfolioSettings() {
  const elements = settingsElements();
  if (!elements) return;

  const manage = (mode) => () =>
    openManageModal(mode, { onChanged: refreshPortfolioSettings });
  document
    .querySelectorAll('[data-action="manage-depots"]')
    .forEach((button) => button.addEventListener("click", manage("depots")));
  document
    .querySelectorAll('[data-action="manage-positions"]')
    .forEach((button) => button.addEventListener("click", manage("positions")));

  elements.benchmark.addEventListener("change", (event) =>
    setFallback(event.target.value),
  );
}
