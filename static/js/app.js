// Register Service Worker for PWA
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/static/sw.js")
      .then((registration) => {
        console.log("[PWA] Service Worker registered:", registration.scope);
      })
      .catch((error) => {
        console.log("[PWA] Service Worker registration failed:", error);
      });
  });
}

// State
let invoices = [];
let currentDate = new Date(); // Current date for navigation reference
let editingInvoiceId = null; // Track if we're editing an invoice
let filterMode = "month"; // 'week', 'month', 'year', 'all', 'custom'
let selectedInvoices = new Set(); // Track selected invoice IDs for bulk operations
let currentView = "invoices"; // 'invoices' or 'stats'
let categoryChart = null; // Chart.js instance for category doughnut
let storeChart = null; // Chart.js instance for store bar chart

// Chart.js color palette matching app theme
const chartColors = [
  "#3b82f6", // blue (accent)
  "#22c55e", // green (success)
  "#f59e0b", // amber
  "#ef4444", // red (danger)
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
  "#84cc16", // lime
  "#6366f1", // indigo
];

// DOM Elements
const invoiceList = document.getElementById("invoice-list");
const searchInput = document.getElementById("search");
const storeFilter = document.getElementById("store-filter");
const typeFilter = document.getElementById("type-filter");
const dateFrom = document.getElementById("date-from");
const dateTo = document.getElementById("date-to");
const sortBy = document.getElementById("sort-by");
const sortOrder = document.getElementById("sort-order");
const monthDisplay = document.getElementById("month-display");

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  applyFilter("month");
  loadInvoices();
  loadStores();
  loadCategories();
  setupEventListeners();
});

function setupEventListeners() {
  searchInput.addEventListener("input", debounce(loadInvoices, 300));
  storeFilter.addEventListener("change", loadInvoices);
  typeFilter.addEventListener("change", loadInvoices);
  // When user manually changes date filters, switch to custom mode
  dateFrom.addEventListener("change", () => {
    if (filterMode !== "custom") {
      filterMode = "custom";
      updateFilterDisplay();
      updateQuickFilterButtons();
    }
    loadInvoices();
  });
  dateTo.addEventListener("change", () => {
    if (filterMode !== "custom") {
      filterMode = "custom";
      updateFilterDisplay();
      updateQuickFilterButtons();
    }
    loadInvoices();
  });
  sortBy.addEventListener("change", loadInvoices);
  sortOrder.addEventListener("change", loadInvoices);

  // Dropzone
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const files = e.dataTransfer.files;
    if (files.length > 0) handleMultipleFiles(files);
  });
  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) handleMultipleFiles(e.target.files);
  });

  // Calculate total on item input
  document
    .getElementById("items-container")
    .addEventListener("input", calculateTotal);
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// API Functions
async function loadInvoices() {
  const params = new URLSearchParams({
    search: getSearchValue(),
    store: storeFilter.value,
    category: typeFilter.value,
    date_from: dateFrom.value,
    date_to: dateTo.value,
    sort_by: sortBy.value,
    sort_order: sortOrder.value,
  });

  try {
    const response = await fetch(`/api/invoices?${params}`);
    invoices = await response.json();
    renderInvoices();

    // Also refresh stats if in stats view
    if (currentView === "stats") {
      loadStats();
    }
  } catch (error) {
    showToast("Failed to load invoices", "error");
  }
}

async function loadStores() {
  try {
    const previousValue = storeFilter.value;
    const response = await fetch("/api/stores");
    const stores = await response.json();

    storeFilter.innerHTML = '<option value="">All Stores</option>';
    stores.forEach((store) => {
      storeFilter.innerHTML += `<option value="${store}">${store}</option>`;
    });

    // Restore filter or jump to next store if previous one no longer exists
    if (previousValue) {
      if (stores.includes(previousValue)) {
        storeFilter.value = previousValue;
      } else if (stores.length > 0) {
        // Find next store alphabetically, or last one if none found
        const nextStore =
          stores.find((s) => s > previousValue) || stores[stores.length - 1];
        storeFilter.value = nextStore;
        loadInvoices();
      }
    }
  } catch (error) {
    console.error("Error loading stores:", error);
  }
}

async function loadCategories() {
  try {
    const typeFilter = document.getElementById("type-filter");
    const previousValue = typeFilter ? typeFilter.value : "";

    const response = await fetch("/api/categories");
    const categories = await response.json();

    // Populate type filter dropdown
    if (typeFilter) {
      typeFilter.innerHTML = '<option value="">All Categories</option>';
      categories.forEach((type) => {
        typeFilter.innerHTML += `<option value="${type}">${type}</option>`;
      });

      // Restore filter or reset to "All Categories" if category no longer exists
      if (previousValue) {
        if (categories.includes(previousValue)) {
          typeFilter.value = previousValue;
        } else {
          typeFilter.value = "";
          loadInvoices();
        }
      }
    }

    // Populate datalist suggestions for add/edit form
    const typeSuggestions = document.getElementById("type-suggestions");
    if (typeSuggestions) {
      typeSuggestions.innerHTML = categories
        .map((type) => `<option value="${type}">`)
        .join("");
    }
  } catch (error) {
    console.error("Error loading categories:", error);
  }
}

// Render Functions
function renderInvoices() {
  // Clear selection for invoices that are no longer in the list
  const currentIds = new Set(invoices.map((inv) => inv.id));
  selectedInvoices.forEach((id) => {
    if (!currentIds.has(id)) {
      selectedInvoices.delete(id);
    }
  });

  if (invoices.length === 0) {
    invoiceList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📋</div>
                <div class="empty-title">No invoices found</div>
                <div class="empty-text">Adjust your filter criteria or add new invoices.</div>
            </div>
        `;
  } else {
    invoiceList.innerHTML = invoices
      .map(
        (invoice) => `
            <div class="invoice-item ${
              selectedInvoices.has(invoice.id) ? "selected" : ""
            }" data-id="${invoice.id}">
                <div class="invoice-header" onclick="toggleInvoice(this)">
                    <label class="invoice-checkbox" onclick="event.stopPropagation()">
                        <input type="checkbox" ${
                          selectedInvoices.has(invoice.id) ? "checked" : ""
                        } onchange="toggleInvoiceSelection(${
                          invoice.id
                        }, this.checked)">
                        <span class="checkbox-mark"></span>
                    </label>
                    <div class="invoice-main">
                        <span class="invoice-date">${formatDate(
                          invoice.date,
                        )}</span>
                        <span class="invoice-store">${escapeHtml(
                          invoice.store,
                        )}</span>
                        ${invoice.category ? `<span class="invoice-type">${escapeHtml(invoice.category)}</span>` : ""}
                    </div>
                    <div class="invoice-meta">
                        <span class="invoice-total">${parseFloat(
                          invoice.total,
                        ).toFixed(2)}</span>
                        <div class="invoice-expand">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"/>
                            </svg>
                        </div>
                    </div>
                </div>
                <div class="invoice-details">
                    <div class="items-table">
                        ${invoice.items
                          .map(
                            (item) => `
                            <div class="item-row">
                                <span class="item-name">${escapeHtml(
                                  item.item_name,
                                )}</span>
                                <span class="item-price">€${parseFloat(
                                  item.item_price,
                                ).toFixed(2)}</span>
                            </div>
                        `,
                          )
                          .join("")}
                    </div>
                    <div class="invoice-actions">
                        <button class="btn btn-secondary btn-sm" onclick="editInvoice(${
                          invoice.id
                        })" style="margin-right: 0.5rem;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            Edit
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="deleteInvoice(${
                          invoice.id
                        })">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="m19 6-.867 12.142A2 2 0 0 1 16.138 20H7.862a2 2 0 0 1-1.995-1.858L5 6"/>
                                <path d="M10 11v6"/>
                                <path d="M14 11v6"/>
                                <path d="m8 6 .544-1.632A2 2 0 0 1 10.442 3h3.116a2 2 0 0 1 1.898 1.368L16 6"/>
                            </svg>
                            Delete
                        </button>
                    </div>
                </div>
            </div>
        `,
      )
      .join("");
  }

  // Calculate total sum of displayed invoices
  const totalSum = invoices.reduce(
    (sum, invoice) => sum + parseFloat(invoice.total),
    0,
  );

  document.getElementById("results-count").textContent = `${
    invoices.length
  } invoice${invoices.length !== 1 ? "s" : ""}`;
  document.getElementById("results-total").textContent = totalSum.toFixed(2);

  updateBulkActionToolbar();
}

function toggleInvoice(element) {
  const item = element.closest(".invoice-item");
  item.classList.toggle("expanded");
}

// Modal Functions
function openAddModal() {
  editingInvoiceId = null;
  document.querySelector("#add-modal .modal-title").textContent = "New Invoice";
  document.getElementById("add-modal").classList.add("active");
  resetAddForm();
  document.getElementById("invoice-date").valueAsDate = new Date();
}

function closeAddModal() {
  document.getElementById("add-modal").classList.remove("active");
  editingInvoiceId = null;
  resetAddForm();
}

async function editInvoice(id) {
  editingInvoiceId = id;
  const invoice = invoices.find((inv) => inv.id === id);

  if (!invoice) {
    showToast("Invoice not found", "error");
    return;
  }

  // Update modal title
  document.querySelector("#add-modal .modal-title").textContent =
    "Edit Invoice";

  // Fill in the form
  document.getElementById("invoice-date").value = invoice.date;
  document.getElementById("invoice-store").value = invoice.store;
  document.getElementById("invoice-type").value = invoice.category || "";

  // Clear and populate items
  const itemsContainer = document.getElementById("items-container");
  itemsContainer.innerHTML = "";

  invoice.items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "item-input-row";
    row.innerHTML = `
            <div class="form-group">
                <label class="form-label">Item Name</label>
                <input type="text" class="form-input item-name" placeholder="Product name" value="${escapeHtml(
                  item.item_name,
                )}">
            </div>
            <div class="form-group">
                <label class="form-label">Price</label>
                <input type="number" step="0.01" class="form-input item-price" placeholder="0.00" value="${
                  item.item_price
                }">
            </div>
            <button type="button" class="btn btn-danger btn-sm" onclick="removeItemRow(this)" style="margin-bottom: 0.375rem;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        `;
    itemsContainer.appendChild(row);
  });

  calculateTotal();
  document.getElementById("add-modal").classList.add("active");
}

function resetAddForm() {
  document.getElementById("add-form").reset();
  document.getElementById("invoice-type").value = "";
  document.getElementById("items-container").innerHTML = `
        <div class="item-input-row">
            <div class="form-group">
                <label class="form-label">Item Name</label>
                <input type="text" class="form-input item-name" placeholder="Product name">
            </div>
            <div class="form-group">
                <label class="form-label">Price</label>
                <input type="number" step="0.01" class="form-input item-price" placeholder="0.00">
            </div>
            <button type="button" class="btn btn-danger btn-sm" onclick="removeItemRow(this)" style="margin-bottom: 0.375rem;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>
    `;
  calculateTotal();
}

function openImportModal() {
  document.getElementById("import-modal").classList.add("active");
}

// Confirm Modal Functions
let confirmModalResolve = null;

/**
 * Show a custom confirmation modal that matches the app design.
 */
function showConfirmModal(message, title = "Confirm Deletion") {
  document.getElementById("confirm-modal-title").textContent = title;
  document.getElementById("confirm-modal-message").textContent = message;
  document.getElementById("confirm-modal").classList.add("active");

  return new Promise((resolve) => {
    confirmModalResolve = resolve;
  });
}

/**
 * Close the confirmation modal and resolve with the user's choice.
 */
function closeConfirmModal(confirmed) {
  document.getElementById("confirm-modal").classList.remove("active");
  if (confirmModalResolve) {
    confirmModalResolve(confirmed);
    confirmModalResolve = null;
  }
}

function closeImportModal() {
  document.getElementById("import-modal").classList.remove("active");
  document.getElementById("json-input").value = "";
  document.getElementById("file-input").value = "";
  pendingFiles = [];
  document.getElementById("selected-files").style.display = "none";
}

// Item Row Functions
function addItemRow() {
  const container = document.getElementById("items-container");
  const row = document.createElement("div");
  row.className = "item-input-row";
  row.innerHTML = `
        <div class="form-group">
            <label class="form-label">Item Name</label>
            <input type="text" class="form-input item-name" placeholder="Product name">
        </div>
        <div class="form-group">
            <label class="form-label">Price</label>
            <input type="number" step="0.01" class="form-input item-price" placeholder="0.00">
        </div>
        <button type="button" class="btn btn-danger btn-sm" onclick="removeItemRow(this)" style="margin-bottom: 0.375rem;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    `;
  container.appendChild(row);
}

function removeItemRow(button) {
  const rows = document.querySelectorAll(".item-input-row");
  if (rows.length > 1) {
    button.closest(".item-input-row").remove();
    calculateTotal();
  }
}

function calculateTotal() {
  const prices = document.querySelectorAll(".item-price");
  let total = 0;
  prices.forEach((input) => {
    total += parseFloat(input.value) || 0;
  });
  document.getElementById("calculated-total").textContent = `€${total.toFixed(
    2,
  )}`;
}

// Save Functions
async function saveInvoice() {
  const date = document.getElementById("invoice-date").value;
  const store = document.getElementById("invoice-store").value;
  const type = document.getElementById("invoice-type").value.trim() || null;

  if (!date || !store) {
    showToast("Please fill in date and store", "error");
    return;
  }

  const items = [];
  const rows = document.querySelectorAll(".item-input-row");
  rows.forEach((row) => {
    const name = row.querySelector(".item-name").value;
    const price = row.querySelector(".item-price").value;
    if (name && price) {
      items.push({ item_name: name, item_price: price });
    }
  });

  const total = items.reduce(
    (sum, item) => sum + parseFloat(item.item_price),
    0,
  );

  try {
    let url = "/api/invoices";
    let method = "POST";
    let successMessage = "Invoice saved";

    if (editingInvoiceId) {
      url = `/api/invoices/${editingInvoiceId}`;
      method = "PUT";
      successMessage = "Invoice updated";
    }

    const response = await fetch(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, store, category: type, total, items }),
    });

    if (response.ok) {
      showToast(successMessage, "success");
      closeAddModal();
      loadInvoices();
      loadStores();
      loadCategories();
    } else {
      showToast("Failed to save", "error");
    }
  } catch (error) {
    showToast("Failed to save", "error");
  }
}

async function deleteInvoice(id) {
  const confirmed = await showConfirmModal(
    "Are you sure you want to delete this invoice?",
  );
  if (!confirmed) return;

  try {
    const response = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
    if (response.ok) {
      showToast("Invoice deleted", "success");
      loadInvoices();
      loadStores();
    } else {
      showToast("Failed to delete", "error");
    }
  } catch (error) {
    showToast("Failed to delete", "error");
  }
}

// Import Functions
let pendingFiles = [];

function handleMultipleFiles(files) {
  pendingFiles = Array.from(files).filter((f) => f.name.endsWith(".json"));
  updateSelectedFilesDisplay();

  // If files were selected, load them all into the textarea
  if (pendingFiles.length > 0) {
    loadFilesIntoTextarea();
  }
}

function updateSelectedFilesDisplay() {
  const container = document.getElementById("selected-files");
  if (pendingFiles.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";
  container.innerHTML = `
        <div style="background: var(--bg-tertiary); border-radius: var(--radius-sm); padding: 0.75rem;">
            <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">
                ${pendingFiles.length} file(s) selected
            </div>
            ${pendingFiles
              .map(
                (f, i) => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.375rem 0; border-bottom: 1px solid var(--border-subtle);">
                    <span style="font-size: 0.875rem;">📄 ${escapeHtml(
                      f.name,
                    )}</span>
                    <button type="button" class="btn btn-danger btn-sm" onclick="removeFile(${i})" style="padding: 0.25rem 0.5rem;">✕</button>
                </div>
            `,
              )
              .join("")}
        </div>
    `;
}

function removeFile(index) {
  pendingFiles.splice(index, 1);
  updateSelectedFilesDisplay();
  loadFilesIntoTextarea();
}

async function loadFilesIntoTextarea() {
  if (pendingFiles.length === 0) {
    document.getElementById("json-input").value = "";
    return;
  }

  const allData = [];

  for (const file of pendingFiles) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        allData.push(...parsed);
      } else {
        allData.push(parsed);
      }
    } catch (e) {
      showToast(`Failed to read ${file.name}`, "error");
    }
  }

  document.getElementById("json-input").value = JSON.stringify(
    allData,
    null,
    2,
  );
}

async function importJson() {
  const jsonText = document.getElementById("json-input").value.trim();
  if (!jsonText) {
    showToast("Please enter JSON data", "error");
    return;
  }

  let data;
  try {
    data = JSON.parse(jsonText);
    if (!Array.isArray(data)) data = [data];
  } catch (error) {
    showToast("Invalid JSON format", "error");
    return;
  }

  // Get import button and show spinner
  const importButton = document.querySelector(
    "#import-modal .modal-footer .btn-primary",
  );
  const originalContent = importButton.innerHTML;
  importButton.innerHTML = '<div class="spinner"></div>';
  importButton.disabled = true;

  try {
    const response = await fetch("/api/invoices/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    const result = await response.json();
    if (result.success) {
      let message = `${result.imported} invoice(s) imported`;
      if (result.skipped > 0) {
        message += `, ${result.skipped} duplicate(s) skipped`;
      }
      showToast(message, "success");
      closeImportModal();
      loadInvoices();
      loadStores();
    } else {
      showToast("Import failed", "error");
    }
  } catch (error) {
    showToast("Import failed", "error");
  } finally {
    // Restore button state
    importButton.innerHTML = originalContent;
    importButton.disabled = false;
  }
}

// Filter and Navigation Functions

// Apply a specific filter mode
function applyFilter(mode) {
  filterMode = mode;
  currentDate = new Date();
  updateFilterDisplay();
  setDateFiltersForMode();
  updateQuickFilterButtons();
}

// Navigate to previous period based on filter mode
function navigateToPrevious() {
  if (filterMode === "all" || filterMode === "custom") return;

  switch (filterMode) {
    case "week":
      currentDate.setDate(currentDate.getDate() - 7);
      break;
    case "month":
      currentDate.setMonth(currentDate.getMonth() - 1);
      break;
    case "year":
      currentDate.setFullYear(currentDate.getFullYear() - 1);
      break;
  }
  updateFilterDisplay();
  setDateFiltersForMode();
  loadInvoices();
}

// Navigate to next period based on filter mode
function navigateToNext() {
  if (filterMode === "all" || filterMode === "custom") return;

  switch (filterMode) {
    case "week":
      currentDate.setDate(currentDate.getDate() + 7);
      break;
    case "month":
      currentDate.setMonth(currentDate.getMonth() + 1);
      break;
    case "year":
      currentDate.setFullYear(currentDate.getFullYear() + 1);
      break;
  }
  updateFilterDisplay();
  setDateFiltersForMode();
  loadInvoices();
}

// Reset to current period for active filter mode
function resetToCurrent() {
  currentDate = new Date();
  updateFilterDisplay();
  setDateFiltersForMode();
  loadInvoices();
}

// Reset all filters back to defaults (current month, no search/store/category)
function resetAllFilters() {
  // Clear search fields
  const mobileSearch = document.getElementById("search");
  const desktopSearch = document.getElementById("search-desktop");
  if (mobileSearch) mobileSearch.value = "";
  if (desktopSearch) desktopSearch.value = "";

  // Reset dropdowns
  storeFilter.value = "";
  typeFilter.value = "";
  sortBy.value = "date";
  sortOrder.value = "desc";

  // Reset to current month
  applyFilter("month");
  loadInvoices();
}

// Update the navigation display based on filter mode
function updateFilterDisplay() {
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const navButtons = document.querySelectorAll(".month-nav-btn");
  const resetBtn = document.querySelector(".month-reset-btn");

  switch (filterMode) {
    case "week":
      const weekNum = getISOWeek(currentDate);
      const weekYear = getISOWeekYear(currentDate);
      monthDisplay.textContent = `W${weekNum} / ${weekYear}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      resetBtn.textContent = "Current Week";
      resetBtn.style.display = "";
      break;
    case "month":
      const monthName = monthNames[currentDate.getMonth()];
      const year = currentDate.getFullYear();
      monthDisplay.textContent = `${monthName} ${year}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      resetBtn.textContent = "Current Month";
      resetBtn.style.display = "";
      break;
    case "year":
      monthDisplay.textContent = `${currentDate.getFullYear()}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      resetBtn.textContent = "Current Year";
      resetBtn.style.display = "";
      break;
    case "all":
      monthDisplay.textContent = "All Invoices";
      navButtons.forEach((btn) => (btn.style.visibility = "hidden"));
      resetBtn.style.display = "none";
      break;
    case "custom":
      monthDisplay.textContent = "Custom";
      navButtons.forEach((btn) => (btn.style.visibility = "hidden"));
      resetBtn.style.display = "none";
      break;
  }
}

// Update quick filter button active state
function updateQuickFilterButtons() {
  const buttons = document.querySelectorAll(".quick-filter-btn");
  buttons.forEach((btn) => {
    const btnMode = btn.getAttribute("data-filter");
    btn.classList.toggle("active", btnMode === filterMode);
  });
}

// Set date filters based on current mode
function setDateFiltersForMode() {
  switch (filterMode) {
    case "week":
      setDateFiltersForWeek(currentDate);
      break;
    case "month":
      setDateFiltersForMonth(currentDate);
      break;
    case "year":
      setDateFiltersForYear(currentDate);
      break;
    case "all":
      dateFrom.value = "";
      dateTo.value = "";
      break;
    case "custom":
      // Don't change the date filters for custom mode
      break;
  }
}

// Calculate ISO week number (weeks start on Monday)
function getISOWeek(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Get the year that the ISO week belongs to
function getISOWeekYear(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}

// Get Monday of the week for a given date
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

// Set date filters for a week (Monday to Sunday)
function setDateFiltersForWeek(date) {
  const monday = getMonday(date);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  dateFrom.value = monday.toLocaleString("sv").split(" ")[0];
  dateTo.value = sunday.toLocaleString("sv").split(" ")[0];
}

// Set date filters for a month
function setDateFiltersForMonth(date) {
  const year = date.getFullYear();
  const month = date.getMonth();

  // First day of the month
  const firstDay = new Date(year, month, 1);
  const firstDayStr = firstDay.toLocaleString("sv").split(" ")[0];

  // Last day of the month
  const lastDay = new Date(year, month + 1, 0);
  const lastDayStr = lastDay.toLocaleString("sv").split(" ")[0];

  dateFrom.value = firstDayStr;
  dateTo.value = lastDayStr;
}

// Set date filters for a year
function setDateFiltersForYear(date) {
  const year = date.getFullYear();

  const firstDay = new Date(year, 0, 1);
  const lastDay = new Date(year, 11, 31);

  dateFrom.value = firstDay.toLocaleString("sv").split(" ")[0];
  dateTo.value = lastDay.toLocaleString("sv").split(" ")[0];
}

// Utility Functions
function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Bulk Selection Functions
function toggleInvoiceSelection(invoiceId, isSelected) {
  if (isSelected) {
    selectedInvoices.add(invoiceId);
  } else {
    selectedInvoices.delete(invoiceId);
  }

  // Update visual state of the invoice item
  const invoiceItem = document.querySelector(
    `.invoice-item[data-id="${invoiceId}"]`,
  );
  if (invoiceItem) {
    invoiceItem.classList.toggle("selected", isSelected);
  }

  updateBulkActionToolbar();
}

function toggleSelectAll(isSelected) {
  if (isSelected) {
    invoices.forEach((invoice) => selectedInvoices.add(invoice.id));
  } else {
    selectedInvoices.clear();
  }
  renderInvoices();
}

function selectAllInvoices() {
  invoices.forEach((invoice) => selectedInvoices.add(invoice.id));
  renderInvoices();
}

function deselectAllInvoices() {
  selectedInvoices.clear();
  renderInvoices();
}

function updateBulkActionToolbar() {
  const toolbar = document.getElementById("bulk-action-toolbar");
  const count = selectedInvoices.size;

  if (count > 0) {
    toolbar.classList.add("visible");
    document.getElementById("selected-count").textContent = count;
  } else {
    toolbar.classList.remove("visible");
  }

  // Update "select all" checkbox state
  const selectAllCheckbox = document.querySelector(
    "#select-all-checkbox input",
  );
  if (selectAllCheckbox && invoices.length > 0) {
    const allSelected = invoices.every((inv) => selectedInvoices.has(inv.id));
    const someSelected = invoices.some((inv) => selectedInvoices.has(inv.id));

    selectAllCheckbox.checked = allSelected;
    selectAllCheckbox.indeterminate = someSelected && !allSelected;
  } else if (selectAllCheckbox) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = false;
  }
}

// Bulk Edit Modal Functions
function openBulkEditModal() {
  if (selectedInvoices.size === 0) return;

  // Get the store names and categories of selected invoices
  const selectedStores = new Set();
  const selectedCategories = new Set();
  invoices.forEach((invoice) => {
    if (selectedInvoices.has(invoice.id)) {
      selectedStores.add(invoice.store);
      if (invoice.category) {
        selectedCategories.add(invoice.category);
      }
    }
  });

  // Pre-fill with the common store name if all selected have the same store
  const storeInput = document.getElementById("bulk-edit-store");
  if (selectedStores.size === 1) {
    storeInput.value = [...selectedStores][0];
  } else {
    storeInput.value = "";
    storeInput.placeholder = `${selectedStores.size} different stores`;
  }

  // Pre-fill with the common category if all selected have the same category
  const categoryInput = document.getElementById("bulk-edit-category");
  if (selectedCategories.size === 1) {
    categoryInput.value = [...selectedCategories][0];
  } else if (selectedCategories.size > 1) {
    categoryInput.value = "";
    categoryInput.placeholder = `${selectedCategories.size} different categories`;
  } else {
    categoryInput.value = "";
    categoryInput.placeholder =
      "e.g. Groceries (leave empty to keep unchanged)";
  }

  // Populate category suggestions
  populateBulkCategorySuggestions();

  document.getElementById("bulk-edit-count").textContent =
    selectedInvoices.size;
  document.getElementById("bulk-edit-modal").classList.add("active");
  storeInput.focus();
}

async function populateBulkCategorySuggestions() {
  try {
    const response = await fetch("/api/categories");
    const categories = await response.json();
    const datalist = document.getElementById("bulk-category-suggestions");
    datalist.innerHTML = categories
      .map((cat) => `<option value="${escapeHtml(cat)}">`)
      .join("");
  } catch (error) {
    console.error("Error loading categories:", error);
  }
}

function closeBulkEditModal() {
  document.getElementById("bulk-edit-modal").classList.remove("active");
  document.getElementById("bulk-edit-store").value = "";
  document.getElementById("bulk-edit-category").value = "";
}

async function saveBulkEdit() {
  const newStore = document.getElementById("bulk-edit-store").value.trim();
  const newCategory = document
    .getElementById("bulk-edit-category")
    .value.trim();

  if (!newStore && !newCategory) {
    showToast("Please fill in at least one field", "error");
    return;
  }

  const ids = [...selectedInvoices];
  const payload = { ids };

  if (newStore) {
    payload.store = newStore;
  }
  if (newCategory) {
    // Only send category if the field has a value
    payload.category = newCategory;
  }

  try {
    const response = await fetch("/api/invoices/bulk-update", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (result.success) {
      showToast(`${result.updated} invoice(s) updated`, "success");
      closeBulkEditModal();
      selectedInvoices.clear();
      loadInvoices();
      loadStores();
      loadCategories();
    } else {
      showToast("Failed to update", "error");
    }
  } catch (error) {
    showToast("Failed to update", "error");
  }
}

async function bulkDeleteInvoices() {
  const count = selectedInvoices.size;
  if (count === 0) return;

  const confirmed = await showConfirmModal(
    `Are you sure you want to permanently delete ${count} invoice${
      count !== 1 ? "s" : ""
    }?`,
  );

  if (!confirmed) return;

  const ids = [...selectedInvoices];

  try {
    const response = await fetch("/api/invoices/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });

    const result = await response.json();
    if (result.success) {
      showToast(`${result.deleted} invoice(s) deleted`, "success");
      selectedInvoices.clear();
      loadInvoices();
      loadStores();
    } else {
      showToast("Failed to delete", "error");
    }
  } catch (error) {
    showToast("Failed to delete", "error");
  }
}

function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
        <span>${type === "success" ? "✓" : "✕"}</span>
        <span>${message}</span>
    `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Mobile responsive functions

/**
 * Toggle the visibility of advanced filters on mobile.
 */
function toggleAdvancedFilters() {
  const filtersGrid = document.getElementById("filters-grid");
  const toggleBtn = document.getElementById("filters-toggle");

  filtersGrid.classList.toggle("visible");
  toggleBtn.classList.toggle("active");
}

/**
 * Sync search input values between mobile and desktop search fields.
 */
function syncSearchInputs() {
  const mobileSearch = document.getElementById("search");
  const desktopSearch = document.getElementById("search-desktop");

  if (!mobileSearch || !desktopSearch) return;

  mobileSearch.addEventListener("input", () => {
    desktopSearch.value = mobileSearch.value;
  });

  desktopSearch.addEventListener(
    "input",
    debounce(() => {
      mobileSearch.value = desktopSearch.value;
      loadInvoices();
    }, 300),
  );
}

/**
 * Get the current search value from either mobile or desktop input.
 */
function getSearchValue() {
  const mobileSearch = document.getElementById("search");
  const desktopSearch = document.getElementById("search-desktop");

  // Return whichever has a value, prioritizing the visible one based on screen size
  if (window.innerWidth <= 640) {
    return mobileSearch?.value || "";
  }
  return desktopSearch?.value || mobileSearch?.value || "";
}

// Initialize search sync on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  syncSearchInputs();
});

// View Switching Functions

/**
 * Switch to the invoices list view.
 */
function showInvoicesView() {
  currentView = "invoices";
  document.getElementById("invoices-view").style.display = "";
  document.getElementById("stats-view").style.display = "none";

  // Update toggle buttons
  document.querySelectorAll(".view-toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === "invoices");
  });
}

/**
 * Switch to the statistics view and load stats data.
 */
function showStatsView() {
  currentView = "stats";
  document.getElementById("invoices-view").style.display = "none";
  document.getElementById("stats-view").style.display = "";

  // Update toggle buttons
  document.querySelectorAll(".view-toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === "stats");
  });

  loadStats();
}

/**
 * Load statistics data from the API using current date filters.
 */
async function loadStats() {
  const params = new URLSearchParams({
    date_from: dateFrom.value,
    date_to: dateTo.value,
  });

  try {
    const response = await fetch(`/api/stats?${params}`);
    const data = await response.json();
    renderStats(data);
  } catch (error) {
    showToast("Failed to load statistics", "error");
  }
}

/**
 * Render statistics data including summary cards and charts.
 */
function renderStats(data) {
  const { summary, by_category, by_store, comparison } = data;
  const statsEmpty = document.getElementById("stats-empty");
  const statsCards = document.querySelector(".stats-cards");
  const statsCharts = document.querySelector(".stats-charts");

  // Handle empty state
  if (summary.total_invoices === 0) {
    statsEmpty.style.display = "";
    statsCards.style.display = "none";
    statsCharts.style.display = "none";
    return;
  }

  statsEmpty.style.display = "none";
  statsCards.style.display = "";
  statsCharts.style.display = "";

  // Update summary cards
  document.getElementById("stats-total").textContent =
    summary.total_amount.toFixed(2);
  document.getElementById("stats-count").textContent = summary.total_invoices;
  document.getElementById("stats-average").textContent =
    summary.average_invoice.toFixed(2);

  // Update change indicator
  const changeEl = document.getElementById("stats-change");
  if (comparison.previous_total > 0) {
    const changePercent = comparison.change_percent;
    const isPositive = changePercent >= 0;
    changeEl.innerHTML = `
      <span class="change-indicator ${isPositive ? "negative" : "positive"}">
        ${isPositive ? "↑" : "↓"} ${Math.abs(changePercent).toFixed(1)}%
      </span>
      <span class="change-label">vs. previous period</span>
    `;
    changeEl.style.display = "";
  } else {
    changeEl.style.display = "none";
  }

  // Render charts
  renderCategoryChart(by_category);
  renderStoreChart(by_store);
}

/**
 * Render the category doughnut chart.
 */
function renderCategoryChart(data) {
  const ctx = document.getElementById("category-chart");
  if (!ctx) return;

  // Destroy existing chart
  if (categoryChart) {
    categoryChart.destroy();
  }

  // Generate legend
  const legendEl = document.getElementById("category-legend");
  const total = data.reduce((sum, item) => sum + item.amount, 0);
  legendEl.innerHTML = data
    .map((item, i) => {
      const percent = total > 0 ? ((item.amount / total) * 100).toFixed(1) : 0;
      return `
        <div class="legend-item">
          <span class="legend-color" style="background: ${chartColors[i % chartColors.length]}"></span>
          <span class="legend-label">${escapeHtml(item.category)}</span>
          <span class="legend-value">€${item.amount.toFixed(2)}</span>
          <span class="legend-percent">${percent}%</span>
        </div>
      `;
    })
    .join("");

  // Create new chart
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
      cutout: "65%",
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: "#1a1a1a",
          titleColor: "#fafafa",
          bodyColor: "#a0a0a0",
          borderColor: "#2a2a2a",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (context) => {
              const value = context.raw;
              const percent =
                total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `€${value.toFixed(2)} (${percent}%)`;
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
  const ctx = document.getElementById("store-chart");
  if (!ctx) return;

  // Destroy existing chart
  if (storeChart) {
    storeChart.destroy();
  }

  // Create new chart
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
          borderRadius: 4,
          barThickness: 24,
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
          backgroundColor: "#1a1a1a",
          titleColor: "#fafafa",
          bodyColor: "#a0a0a0",
          borderColor: "#2a2a2a",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (context) => `€${context.raw.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          grid: {
            color: "#2a2a2a",
            drawBorder: false,
          },
          ticks: {
            color: "#666666",
            callback: (value) => `€${value}`,
          },
        },
        y: {
          grid: {
            display: false,
          },
          ticks: {
            color: "#a0a0a0",
          },
        },
      },
    },
  });
}
