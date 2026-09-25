/**
 * The mobile advanced-filters toggle and the statistics rendering with Chart.js
 * (the global `Chart` UMD from the CDN). View switching lives in views.js.
 */

import { chartColors } from "./state.js";
import {
  els,
  escapeHtml,
  formatCurrency,
  mobileViewport,
  withEuro,
} from "./dom.js";
import { showErrorToast } from "./toast.js";
import { lockScroll, unlockScroll } from "./modals.js";
import { apiFetch } from "./http.js";

// Chart.js instances, kept so a re-render can destroy the previous one.
let categoryChart = null;
let storeChart = null;

/**
 * Sync the scrim class and body scroll lock to the filter panel's current
 * visible/viewport state. Runs on toggle and on breakpoint crossings, so an
 * open panel gains/loses its sheet chrome when the viewport changes.
 */
function syncFilterSheetChrome() {
  const collapsible = document.querySelector('[data-el="filters-collapsible"]');
  const mobileOpen =
    collapsible.classList.contains("visible") && mobileViewport.matches;
  document.body.classList.toggle("filter-sheet-open", mobileOpen);
  if (mobileOpen) lockScroll();
  else unlockScroll();
}

/**
 * Toggle the advanced filter panel — an inline collapsible on desktop, a
 * bottom sheet (with scrim and scroll lock) on mobile.
 */
export function toggleAdvancedFilters() {
  const collapsible = document.querySelector('[data-el="filters-collapsible"]');
  const toggleBtn = document.querySelector('[data-el="filters-toggle"]');

  const isOpen = collapsible.classList.toggle("visible");
  // Setting inert on a subtree that holds focus blurs to <body>, so hand focus
  // back to the toggle first and keyboard users are not stranded.
  if (!isOpen && collapsible.contains(document.activeElement))
    toggleBtn.focus();
  // A collapsed panel is only transparent, not hidden: without inert its
  // controls stay tabbable and keep swallowing clicks meant for the list below.
  collapsible.inert = !isOpen;
  toggleBtn.setAttribute("aria-expanded", String(isOpen));
  toggleBtn.classList.toggle("active", isOpen);
  syncFilterSheetChrome();
}

/**
 * Wire the mobile advanced-filters toggle and its sheet chrome.
 */
export function setupStatsListeners() {
  document
    .querySelector('[data-el="filters-toggle"]')
    .addEventListener("click", toggleAdvancedFilters);

  // Mobile filter sheet: scrim tap and the sheet's own ✕ both close it.
  const closeFilterSheet = () => {
    const collapsible = document.querySelector(
      '[data-el="filters-collapsible"]',
    );
    if (collapsible.classList.contains("visible")) toggleAdvancedFilters();
  };
  document
    .querySelector('[data-el="filter-sheet-scrim"]')
    .addEventListener("click", closeFilterSheet);

  // Crossing the 640px breakpoint while the panel is open must add/remove
  // the sheet chrome (scrim + scroll lock) without another toggle.
  mobileViewport.addEventListener("change", syncFilterSheetChrome);
  document
    .querySelector('[data-action="close-filter-sheet"]')
    .addEventListener("click", closeFilterSheet);
}

/**
 * Load statistics data from the API using current date filters.
 */
export async function loadStats() {
  const { dateFrom, dateTo } = els();
  const params = new URLSearchParams({
    date_from: dateFrom.value,
    date_to: dateTo.value,
  });

  try {
    const response = await apiFetch(`/api/stats?${params}`);
    const data = await response.json();
    renderStats(data);
  } catch {
    showErrorToast("Failed to load statistics");
  }
}

/**
 * Render statistics data including summary cards and charts.
 */
function renderStats(data) {
  const { summary, by_category, by_store, comparison } = data;
  const statsEmpty = document.querySelector('[data-el="stats-empty"]');
  const statsCards = document.querySelector(".stats-cards");
  const statsCharts = document.querySelector(".stats-charts");

  if (summary.total_invoices === 0) {
    statsEmpty.classList.remove("is-hidden");
    statsCards.classList.add("is-hidden");
    statsCharts.classList.add("is-hidden");
    return;
  }

  statsEmpty.classList.add("is-hidden");
  statsCards.classList.remove("is-hidden");
  statsCharts.classList.remove("is-hidden");

  document.querySelector('[data-el="stats-total"]').textContent =
    formatCurrency(summary.total_amount);
  document.querySelector('[data-el="stats-count"]').textContent =
    summary.total_invoices;
  document.querySelector('[data-el="stats-average"]').textContent =
    formatCurrency(summary.average_invoice);

  const changeEl = document.querySelector('[data-el="stats-change"]');
  if (comparison.previous_total > 0) {
    const changePercent = comparison.change_percent;
    const isPositive = changePercent >= 0;
    changeEl.innerHTML = `
      <span class="change-indicator ${isPositive ? "negative" : "positive"}">
        ${isPositive ? "↑" : "↓"} ${Math.abs(changePercent).toFixed(1)}%
      </span>
      <span class="change-label">vs. previous period</span>
    `;
    changeEl.classList.remove("is-hidden");
  } else {
    changeEl.classList.add("is-hidden");
  }

  renderCategoryChart(by_category);
  renderStoreChart(by_store);
}

/**
 * Render the category doughnut chart.
 */
function renderCategoryChart(data) {
  const ctx = document.querySelector('[data-el="category-chart"]');
  if (!ctx) return;

  if (categoryChart) {
    categoryChart.destroy();
  }

  const legendEl = document.querySelector('[data-el="category-legend"]');
  const total = data.reduce((sum, item) => sum + item.amount, 0);
  legendEl.innerHTML = data
    .map((item) => {
      const percent = total > 0 ? ((item.amount / total) * 100).toFixed(1) : 0;
      return `
        <div class="legend-item">
          <span class="legend-color"></span>
          <span class="legend-label">${escapeHtml(item.category)}</span>
          <span class="legend-value">${withEuro(formatCurrency(item.amount))}</span>
          <span class="legend-percent">${percent}%</span>
        </div>
      `;
    })
    .join("");
  // Paint the swatches via the CSSOM (not a style attribute) so a strict
  // style-src CSP does not block them; order matches the chart data.
  legendEl.querySelectorAll(".legend-color").forEach((swatch, i) => {
    swatch.style.background = chartColors[i % chartColors.length];
  });

  categoryChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: data.map((item) => item.category),
      datasets: [
        {
          data: data.map((item) => item.amount),
          backgroundColor: data.map(
            (_, i) => chartColors[i % chartColors.length],
          ),
          borderWidth: 0,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "55%",
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: "#fdf9f1",
          titleColor: "#3a332a",
          bodyColor: "#6b5f4a",
          borderColor: "#e2d8c2",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (context) => {
              const value = context.raw;
              const percent =
                total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${withEuro(formatCurrency(value))} (${percent}%)`;
            },
          },
        },
      },
    },
  });
}

/**
 * Render the store horizontal bar chart.
 */
function renderStoreChart(data) {
  const ctx = document.querySelector('[data-el="store-chart"]');
  if (!ctx) return;

  if (storeChart) {
    storeChart.destroy();
  }

  // Design 6a: thinner bars, 82px ellipsized label column, smaller mono ticks.
  const mobile = mobileViewport.matches;

  storeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((item) => item.store),
      datasets: [
        {
          data: data.map((item) => item.amount),
          backgroundColor: data.map(
            (_, i) => chartColors[i % chartColors.length],
          ),
          borderRadius: 5,
          barThickness: mobile ? 15 : 16,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: "#fdf9f1",
          titleColor: "#3a332a",
          bodyColor: "#6b5f4a",
          borderColor: "#e2d8c2",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (context) => withEuro(formatCurrency(context.raw)),
          },
        },
      },
      scales: {
        x: {
          grid: {
            color: "#efe7d5",
            drawBorder: false,
          },
          ticks: {
            color: "#8a7c62",
            font: mobile
              ? { size: 10.5, family: "'JetBrains Mono', monospace" }
              : undefined,
            callback: (value) => withEuro(value),
          },
        },
        y: {
          grid: {
            display: false,
          },
          afterFit: (scale) => {
            if (mobile) scale.width = 82;
          },
          ticks: {
            color: "#6b5f4a",
            font: mobile ? { size: 10.5 } : undefined,
            callback: function (value) {
              const label = this.getLabelForValue(value);
              if (!mobile || label.length <= 11) return label;
              return `${label.slice(0, 10)}…`;
            },
          },
        },
      },
    },
  });
}
