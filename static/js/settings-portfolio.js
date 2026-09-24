/**
 * Settings → Portfolio: the two Manage rows and the benchmark fallback select.
 * Reads `GET /api/portfolio?range=max`, the only endpoint with closed positions.
 */

import { apiFetch, errorMessage, sendJson } from "./http.js";
import { showErrorToast, showNoticeToast } from "./toast.js";
import { escapeHtml } from "./dom.js";
import { loadPortfolio } from "./portfolio.js";
import { openManageModal } from "./portfolio-manage.js";

// Remembered because clearing the select must unflag a row the payload no longer names.
let fallbackId = null;

/** The section's hooks, or `null` when absent, so a settings fixture never fetches. */
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
 * Fill the select with the active positions. Closed ones are left out: their
 * value stops at the sale, so a benchmark from them would flatline.
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

function renderSection(elements, depots) {
  elements.depots.textContent = depotsSummary(depots);
  elements.positions.textContent = positionsSummary(depots);
  renderBenchmarkOptions(elements.benchmark, depots);
}

/**
 * Refill the section; reports its own failures, so callers need not await it.
 * Passing already fetched `depots` skips the refetch; `null` fetches.
 */
export async function refreshPortfolioSettings(depots = null) {
  const elements = settingsElements();
  if (!elements) return;

  if (depots) {
    renderSection(elements, depots);
    return;
  }

  try {
    const response = await apiFetch("/api/portfolio?range=max");
    if (!response.ok) {
      throw new Error(`Portfolio settings failed: ${response.status}`);
    }
    renderSection(elements, (await response.json()).depots);
  } catch (error) {
    console.error("Error loading portfolio settings:", error);
  }
}

/** Move the benchmark fallback flag, or clear it; the server clears the others. */
async function setFallback(value) {
  const selected = value === "" ? null : Number(value);
  const target = selected ?? fallbackId;
  if (target === null) return;

  const previous = fallbackId;
  try {
    const response = await sendJson(
      `/api/portfolio/positions/${target}`,
      "PATCH",
      { is_benchmark_fallback: selected !== null },
    );
    if (!response.ok) {
      showErrorToast(
        await errorMessage(response, "Failed to set the benchmark"),
      );
      settingsElements().benchmark.value =
        previous === null ? "" : String(previous);
      return;
    }

    fallbackId = selected;
    showNoticeToast("Benchmark updated");
    // The list behind the dialog shows the badge on the flagged row.
    await loadPortfolio();
  } catch (error) {
    console.error("Error setting the benchmark:", error);
    showErrorToast("Failed to set the benchmark");
  }
}

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
