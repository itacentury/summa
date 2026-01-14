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

// DOM Elements
const invoiceList = document.getElementById("invoice-list");
const searchInput = document.getElementById("search");
const storeFilter = document.getElementById("store-filter");
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
  setupEventListeners();
});

function setupEventListeners() {
  searchInput.addEventListener("input", debounce(loadInvoices, 300));
  storeFilter.addEventListener("change", loadInvoices);
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
    date_from: dateFrom.value,
    date_to: dateTo.value,
    sort_by: sortBy.value,
    sort_order: sortOrder.value,
  });

  try {
    const response = await fetch(`/api/invoices?${params}`);
    invoices = await response.json();
    renderInvoices();
  } catch (error) {
    showToast("Fehler beim Laden der Rechnungen", "error");
  }
}

async function loadStores() {
  try {
    const response = await fetch("/api/stores");
    const stores = await response.json();
    storeFilter.innerHTML = '<option value="">Alle Geschäfte</option>';
    stores.forEach((store) => {
      storeFilter.innerHTML += `<option value="${store}">${store}</option>`;
    });
  } catch (error) {
    console.error("Error loading stores:", error);
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
                <div class="empty-title">Keine Rechnungen gefunden</div>
                <div class="empty-text">Passe deine Filterkriterien an oder füge neue Rechnungen hinzu.</div>
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
                          invoice.date
                        )}</span>
                        <span class="invoice-store">${escapeHtml(
                          invoice.store
                        )}</span>
                    </div>
                    <div class="invoice-meta">
                        <span class="invoice-total">${parseFloat(
                          invoice.total
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
                                  item.item_name
                                )}</span>
                                <span class="item-price">€${parseFloat(
                                  item.item_price
                                ).toFixed(2)}</span>
                            </div>
                        `
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
                            Bearbeiten
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
                            Löschen
                        </button>
                    </div>
                </div>
            </div>
        `
      )
      .join("");
  }

  // Calculate total sum of displayed invoices
  const totalSum = invoices.reduce(
    (sum, invoice) => sum + parseFloat(invoice.total),
    0
  );

  document.getElementById("results-count").textContent = `${
    invoices.length
  } Rechnung${invoices.length !== 1 ? "en" : ""}`;
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
  document.querySelector("#add-modal .modal-title").textContent =
    "Neue Rechnung";
  document.getElementById("add-modal").classList.add("active");
  document.getElementById("invoice-date").valueAsDate = new Date();
  resetAddForm();
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
    showToast("Rechnung nicht gefunden", "error");
    return;
  }

  // Update modal title
  document.querySelector("#add-modal .modal-title").textContent =
    "Rechnung bearbeiten";

  // Fill in the form
  document.getElementById("invoice-date").value = invoice.date;
  document.getElementById("invoice-store").value = invoice.store;

  // Clear and populate items
  const itemsContainer = document.getElementById("items-container");
  itemsContainer.innerHTML = "";

  invoice.items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "item-input-row";
    row.innerHTML = `
            <div class="form-group">
                <label class="form-label">Artikelname</label>
                <input type="text" class="form-input item-name" placeholder="Produktname" value="${escapeHtml(
                  item.item_name
                )}">
            </div>
            <div class="form-group">
                <label class="form-label">Preis (€)</label>
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
  document.getElementById("items-container").innerHTML = `
        <div class="item-input-row">
            <div class="form-group">
                <label class="form-label">Artikelname</label>
                <input type="text" class="form-input item-name" placeholder="Produktname">
            </div>
            <div class="form-group">
                <label class="form-label">Preis (€)</label>
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
function showConfirmModal(message, title = "Löschen bestätigen") {
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
            <label class="form-label">Artikelname</label>
            <input type="text" class="form-input item-name" placeholder="Produktname">
        </div>
        <div class="form-group">
            <label class="form-label">Preis (€)</label>
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
    2
  )}`;
}

// Save Functions
async function saveInvoice() {
  const date = document.getElementById("invoice-date").value;
  const store = document.getElementById("invoice-store").value;

  if (!date || !store) {
    showToast("Bitte Datum und Geschäft ausfüllen", "error");
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
    0
  );

  try {
    let url = "/api/invoices";
    let method = "POST";
    let successMessage = "Rechnung gespeichert";

    if (editingInvoiceId) {
      url = `/api/invoices/${editingInvoiceId}`;
      method = "PUT";
      successMessage = "Rechnung aktualisiert";
    }

    const response = await fetch(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, store, total, items }),
    });

    if (response.ok) {
      showToast(successMessage, "success");
      closeAddModal();
      loadInvoices();
      loadStores();
    } else {
      showToast("Fehler beim Speichern", "error");
    }
  } catch (error) {
    showToast("Fehler beim Speichern", "error");
  }
}

async function deleteInvoice(id) {
  const confirmed = await showConfirmModal(
    "Möchtest du diese Rechnung wirklich löschen?"
  );
  if (!confirmed) return;

  try {
    const response = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
    if (response.ok) {
      showToast("Rechnung gelöscht", "success");
      loadInvoices();
      loadStores();
    } else {
      showToast("Fehler beim Löschen", "error");
    }
  } catch (error) {
    showToast("Fehler beim Löschen", "error");
  }
}

// Import Functions
let pendingFiles = [];

function handleMultipleFiles(files) {
  pendingFiles = Array.from(files).filter((f) => f.name.endsWith(".json"));
  updateSelectedFilesDisplay();

  // Wenn Dateien ausgewählt wurden, lade sie alle in die Textarea
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
                ${pendingFiles.length} Datei(en) ausgewählt
            </div>
            ${pendingFiles
              .map(
                (f, i) => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.375rem 0; border-bottom: 1px solid var(--border-subtle);">
                    <span style="font-size: 0.875rem;">📄 ${escapeHtml(
                      f.name
                    )}</span>
                    <button type="button" class="btn btn-danger btn-sm" onclick="removeFile(${i})" style="padding: 0.25rem 0.5rem;">✕</button>
                </div>
            `
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
      showToast(`Fehler beim Lesen von ${file.name}`, "error");
    }
  }

  document.getElementById("json-input").value = JSON.stringify(
    allData,
    null,
    2
  );
}

async function importJson() {
  const jsonText = document.getElementById("json-input").value.trim();
  if (!jsonText) {
    showToast("Bitte JSON-Daten eingeben", "error");
    return;
  }

  let data;
  try {
    data = JSON.parse(jsonText);
    if (!Array.isArray(data)) data = [data];
  } catch (error) {
    showToast("Ungültiges JSON-Format", "error");
    return;
  }

  // Get import button and show spinner
  const importButton = document.querySelector(
    "#import-modal .modal-footer .btn-primary"
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
      let message = `${result.imported} Rechnung(en) importiert`;
      if (result.skipped > 0) {
        message += `, ${result.skipped} Duplikat(e) übersprungen`;
      }
      showToast(message, "success");
      closeImportModal();
      loadInvoices();
      loadStores();
    } else {
      showToast("Fehler beim Import", "error");
    }
  } catch (error) {
    showToast("Fehler beim Import", "error");
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

// Update the navigation display based on filter mode
function updateFilterDisplay() {
  const monthNames = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ];

  const navButtons = document.querySelectorAll(".month-nav-btn");
  const resetBtn = document.querySelector(".month-reset-btn");

  switch (filterMode) {
    case "week":
      const weekNum = getISOWeek(currentDate);
      const weekYear = getISOWeekYear(currentDate);
      monthDisplay.textContent = `KW ${weekNum} / ${weekYear}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      resetBtn.textContent = "Aktuelle Woche";
      resetBtn.style.display = "";
      break;
    case "month":
      const monthName = monthNames[currentDate.getMonth()];
      const year = currentDate.getFullYear();
      monthDisplay.textContent = `${monthName} ${year}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      resetBtn.textContent = "Aktueller Monat";
      resetBtn.style.display = "";
      break;
    case "year":
      monthDisplay.textContent = `${currentDate.getFullYear()}`;
      navButtons.forEach((btn) => (btn.style.visibility = "visible"));
      resetBtn.textContent = "Aktuelles Jahr";
      resetBtn.style.display = "";
      break;
    case "all":
      monthDisplay.textContent = "Alle Rechnungen";
      navButtons.forEach((btn) => (btn.style.visibility = "hidden"));
      resetBtn.style.display = "none";
      break;
    case "custom":
      monthDisplay.textContent = "Benutzerdefiniert";
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
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Get the year that the ISO week belongs to
function getISOWeekYear(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
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

  dateFrom.value = monday.toISOString().split("T")[0];
  dateTo.value = sunday.toISOString().split("T")[0];
}

// Set date filters for a month
function setDateFiltersForMonth(date) {
  const year = date.getFullYear();
  const month = date.getMonth();

  // First day of the month
  const firstDay = new Date(year, month, 1);
  const firstDayStr = firstDay.toISOString().split("T")[0];

  // Last day of the month
  const lastDay = new Date(year, month + 1, 0);
  const lastDayStr = lastDay.toISOString().split("T")[0];

  dateFrom.value = firstDayStr;
  dateTo.value = lastDayStr;
}

// Set date filters for a year
function setDateFiltersForYear(date) {
  const year = date.getFullYear();

  const firstDay = new Date(year, 0, 1);
  const lastDay = new Date(year, 11, 31);

  dateFrom.value = firstDay.toISOString().split("T")[0];
  dateTo.value = lastDay.toISOString().split("T")[0];
}

// Utility Functions
function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString("de-DE", {
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
    `.invoice-item[data-id="${invoiceId}"]`
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
    "#select-all-checkbox input"
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

  // Get the store names of selected invoices
  const selectedStores = new Set();
  invoices.forEach((invoice) => {
    if (selectedInvoices.has(invoice.id)) {
      selectedStores.add(invoice.store);
    }
  });

  // Pre-fill with the common store name if all selected have the same store
  const storeInput = document.getElementById("bulk-edit-store");
  if (selectedStores.size === 1) {
    storeInput.value = [...selectedStores][0];
  } else {
    storeInput.value = "";
    storeInput.placeholder = `${selectedStores.size} verschiedene Geschäfte`;
  }

  document.getElementById("bulk-edit-count").textContent =
    selectedInvoices.size;
  document.getElementById("bulk-edit-modal").classList.add("active");
  storeInput.focus();
}

function closeBulkEditModal() {
  document.getElementById("bulk-edit-modal").classList.remove("active");
  document.getElementById("bulk-edit-store").value = "";
}

async function saveBulkEdit() {
  const newStore = document.getElementById("bulk-edit-store").value.trim();

  if (!newStore) {
    showToast("Bitte einen Geschäftsnamen eingeben", "error");
    return;
  }

  const ids = [...selectedInvoices];

  try {
    const response = await fetch("/api/invoices/bulk-update", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, store: newStore }),
    });

    const result = await response.json();
    if (result.success) {
      showToast(`${result.updated} Rechnung(en) aktualisiert`, "success");
      closeBulkEditModal();
      selectedInvoices.clear();
      loadInvoices();
      loadStores();
    } else {
      showToast("Fehler beim Aktualisieren", "error");
    }
  } catch (error) {
    showToast("Fehler beim Aktualisieren", "error");
  }
}

async function bulkDeleteInvoices() {
  const count = selectedInvoices.size;
  if (count === 0) return;

  const confirmed = await showConfirmModal(
    `Möchtest du wirklich ${count} Rechnung${
      count !== 1 ? "en" : ""
    } unwiderruflich löschen?`
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
      showToast(`${result.deleted} Rechnung(en) gelöscht`, "success");
      selectedInvoices.clear();
      loadInvoices();
      loadStores();
    } else {
      showToast("Fehler beim Löschen", "error");
    }
  } catch (error) {
    showToast("Fehler beim Löschen", "error");
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
    }, 300)
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
