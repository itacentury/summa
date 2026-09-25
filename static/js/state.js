/**
 * Shared mutable application state, one object per concern.
 *
 * Reassigned values live as properties on these objects because ES module
 * import bindings are read-only — a module cannot reassign an imported `let`,
 * but it can mutate a property of an imported object.
 */

// The invoice list, its filters, the add/edit dialog and the import staging.
export const invoiceState = {
  invoices: [],
  page: 1, // Current invoice-list page (1-based)
  pageSize: 25, // Invoices requested per page
  effectivePageSize: 25, // Server-clamped page size from the last response; drives totalPages
  totalCount: 0, // Total invoices matching the active filters
  uncategorizedCount: 0, // Uncategorized invoices matching the active filters, across all pages
  totalSum: 0, // Sum of totals across all matching invoices
  currentDate: new Date(), // Current date for navigation reference
  editingInvoiceId: null, // Track if we're editing an invoice
  filterMode: "month", // 'week', 'month', 'year', 'all', 'custom'
  pendingFiles: [], // Staged JSON files for import
  importErrors: [], // Invalid entries from the last import (index/field/message/value)
};

// Which of the three views is shown; set only by views.js.
export const viewState = {
  currentView: "invoices", // 'invoices', 'stats' or 'portfolio'
};

// The portfolio view's filters and its Chart.js instances.
export const portfolioState = {
  portfolioRange: "1y", // Portfolio period: '3m', '1y', 'ytd', 'max'
  depotFilter: "all", // 'all' or a depot id as a string
  portfolioPositions: "all", // 'all', or an array of position ids the chart draws
  portfolioChart: null, // Chart.js instance for the value-over-time line
  allocationChart: null, // Chart.js instance for the allocation doughnut
};

// Track selected invoice IDs for bulk operations (mutated, never reassigned).
export const selectedInvoices = new Set();

// Selectable invoice-per-page counts offered by the pagination size selector.
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

// Wire value for the "All" page-size option: the server returns every matching
// row on one page instead of clamping to a numeric maximum.
export const ALL_PAGE_SIZE = "all";

// localStorage key persisting the chosen page size across sessions.
export const PAGE_SIZE_STORAGE_KEY = "summa.pageSize";

// Portfolio depot groups the user collapsed, and position rows expanded into their
// detail strip. Session-only by design (mutated, never reassigned).
export const collapsedDepots = new Set();
export const expandedPositions = new Set();

// Period tokens the portfolio view accepts; also the allowlist a restored
// localStorage value is validated against.
export const PORTFOLIO_RANGES = ["3m", "1y", "ytd", "max"];

// localStorage keys persisting the portfolio period and depot filter. They are
// separate from the invoice filters so neither view inherits the other's period.
export const PORTFOLIO_RANGE_STORAGE_KEY = "summa.portfolio.range";
export const PORTFOLIO_DEPOT_STORAGE_KEY = "summa.portfolio.depot";

// localStorage key persisting the chart's position selection. Unlike the two
// above it holds JSON, because the value is either a sentinel or a list of ids.
export const PORTFOLIO_POSITIONS_STORAGE_KEY = "summa.portfolio.positions";

// Chart.js color palette: warm-sand chart tones (--chart-1…8), donut/bar order.
export const chartColors = [
  "#c9a87c",
  "#a8bfa0",
  "#d9a48a",
  "#b5a184",
  "#c4b3d6",
  "#d6bfa0",
  "#a3c2c2",
  "#e0cdb0",
];

// How many positions the chart draws at once. The palette is the limit, not the
// other way round: a ninth line could only repeat a colour the legend already
// spends on another holding.
export const PORTFOLIO_MAX_LINES = chartColors.length;

// Which palette slot each selected position draws in (position id -> index into
// chartColors). Session-only and rebuilt from the restored selection, like the
// two sets above: mutated, never reassigned.
export const positionLineColors = new Map();
