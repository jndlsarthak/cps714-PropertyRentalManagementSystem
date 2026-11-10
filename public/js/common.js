/* =====================================================================
   PRMS - shared JavaScript used by every page
   - api(): talks to the server
   - initPage(): checks login, draws the navbar + role menu (Tasks 2 & 8)
   - small formatting helpers
   ===================================================================== */

const ROLE_LABELS = {
  admin: 'Admin',
  owner: 'Landlord / Owner',
  manager: 'Property Manager',
  tenant: 'Tenant',
  staff: 'Maintenance Staff',
  contractor: 'Contractor',
};

// The menu each role sees after logging in
const MANAGER_MENU = [
  { href: 'manager-listings.html', label: 'My Listings' },
  { href: 'listing-form.html', label: 'Create Listing' },
  { href: 'manager-applications.html', label: 'Applications' },
  { href: 'manager-maintenance.html', label: 'Maintenance Requests' },
  { href: 'messages.html', label: 'Messages', unread: true },
];

const MENUS = {
  admin: [
    { href: 'dashboard.html', label: 'Dashboard' },
    { href: 'admin-create-user.html', label: 'Create User' },
    { href: 'admin-users.html', label: 'Users' },
    { href: 'admin-listings.html', label: 'All Listings' },
    { href: 'admin-maintenance.html', label: 'All Maintenance Requests' },
  ],
  owner: [
    { href: 'dashboard.html', label: 'Dashboard' },
    { href: 'owner-add-property.html', label: 'Add Property' },
    { href: 'owner-properties.html', label: 'My Properties' },
    { href: 'owner-occupancy.html', label: 'Occupancy & Leases' },
    { href: 'owner-spending.html', label: 'Maintenance Spending' },
    // shown only when the owner manages at least one property themselves
    { section: 'Self-managed properties', selfManaged: true },
    ...MANAGER_MENU.map((m) => ({ ...m, selfManaged: true })),
  ],
  manager: [{ href: 'dashboard.html', label: 'Dashboard' }, ...MANAGER_MENU],
  tenant: [
    { href: 'dashboard.html', label: 'Dashboard' },
    { href: 'listings.html', label: 'Browse Listings' },
    { href: 'my-applications.html', label: 'My Applications' },
    { href: 'maintenance-new.html', label: 'New Maintenance Request' },
    { href: 'my-requests.html', label: 'My Requests' },
    { href: 'pay.html', label: 'Pay Rent / Deposit' },
    { href: 'payments.html', label: 'Payment History' },
    { href: 'messages.html', label: 'Messages', unread: true },
  ],
  staff: [
    { href: 'dashboard.html', label: 'Dashboard' },
    { href: 'workorders.html', label: 'My Work Orders' },
  ],
  contractor: [
    { href: 'dashboard.html', label: 'Dashboard' },
    { href: 'workorders.html', label: 'My Work Orders' },
  ],
};

// Pages that are not in the menu highlight their "parent" menu item
const MENU_PARENT = { 'listing.html': 'listings.html' };

/* ---------- API helper ---------- */
async function api(method, url, body) {
  const options = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (res.status === 401 && url !== '/api/login') {
    location.href = '/index.html';
    throw new Error('Please log in.');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

/* ---------- Layout ---------- */
function visibleMenu(user) {
  return (MENUS[user.role] || []).filter((item) => !item.selfManaged || user.selfManaged > 0);
}

async function initPage() {
  const { user } = await api('GET', '/api/me');
  window.ME = user;
  renderLayout(user);
  return user;
}

function renderLayout(user) {
  let current = location.pathname.split('/').pop() || 'dashboard.html';
  if (current === 'listing-form.html' && param('id')) current = 'manager-listings.html';
  current = MENU_PARENT[current] || current;

  const topbar = document.getElementById('topbar');
  topbar.className = 'topbar';
  topbar.innerHTML = `
    <div class="topbar-left">
      <button class="menu-toggle" id="menuToggle" aria-label="Open menu">☰</button>
      <a class="brand" href="dashboard.html">
        <span class="brand-logo">P</span>
        <span>PRMS<small>Property Rental Management</small></span>
      </a>
    </div>
    <div class="topbar-right">
      <div class="user-chip"><strong>${esc(user.name)}</strong><span>${esc(ROLE_LABELS[user.role])}</span></div>
      <button class="btn secondary sm" id="logoutBtn">Log out</button>
    </div>`;

  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = visibleMenu(user).map((item) => {
    if (item.section) return `<div class="section">${esc(item.section)}</div>`;
    const count = item.unread && user.unread ? `<span class="count">${user.unread}</span>` : '';
    return `<a href="${item.href}" class="${item.href === current ? 'active' : ''}">${esc(item.label)}${count}</a>`;
  }).join('');

  document.getElementById('logoutBtn').onclick = logout;
  document.getElementById('menuToggle').onclick = () => document.body.classList.toggle('menu-open');
}

async function logout() {
  try { await api('POST', '/api/logout'); } finally { location.href = '/index.html'; }
}

/* ---------- Formatting helpers ---------- */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// SQLite dates are "YYYY-MM-DD" (local) or "YYYY-MM-DD HH:MM:SS" (UTC)
function toDate(s) {
  if (!s) return null;
  return s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s.replace(' ', 'T') + 'Z');
}
function fmtDate(s) {
  const d = toDate(s);
  return d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}
function fmtDateTime(s) {
  const d = toDate(s);
  return d ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}
function daysUntil(s) {
  const d = toDate(s);
  return d ? Math.ceil((d - new Date()) / 86400000) : null;
}

const BADGE_COLORS = {
  Active: 'green', Approved: 'green', Completed: 'green', Paid: 'green',
  Pending: 'yellow', Submitted: 'yellow', Medium: 'yellow', 'Ending soon': 'yellow',
  Assigned: 'blue', Occupied: 'blue', Rent: 'blue',
  Declined: 'red', Suspended: 'red', High: 'red', Expired: 'red',
  Leased: 'purple', Deposit: 'purple',
  Inactive: 'gray', Vacant: 'gray', Low: 'gray',
};
function badge(text) {
  return `<span class="badge ${BADGE_COLORS[text] || 'gray'}">${esc(text)}</span>`;
}

function stars(rating) {
  const r = Math.round(Number(rating) || 0);
  return `<span class="stars" title="${rating} / 5">${'★'.repeat(r)}<span class="off">${'★'.repeat(5 - r)}</span></span>`;
}

function photo(url, alt) {
  const fallback = `<div class="photo photo-fallback">No photo</div>`;
  if (!url) return fallback;
  return `<img class="photo" src="${esc(url)}" alt="${esc(alt || 'Listing photo')}" loading="lazy"
           onerror="this.outerHTML='${fallback.replace(/"/g, '&quot;')}'">`;
}

/* ---------- Form + message helpers ---------- */
function showAlert(target, message, type = 'error') {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  el.innerHTML = message ? `<div class="alert ${type}">${esc(message)}</div>` : '';
  if (message) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function formData(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) data[key] = typeof value === 'string' ? value.trim() : value;
  return data;
}

// errors = { fieldName: 'message' }. Returns true when there are no errors.
function setErrors(form, errors) {
  form.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
  for (const [name, message] of Object.entries(errors)) {
    const input = form.elements[name];
    const field = input && input.closest ? input.closest('.field') : null;
    if (!field) continue;
    let el = field.querySelector('.field-error');
    if (!el) {
      el = document.createElement('div');
      el.className = 'field-error';
      field.appendChild(el);
    }
    el.textContent = message;
    field.classList.add('invalid');
  }
  const first = form.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea');
  if (first) first.focus();
  return Object.keys(errors).length === 0;
}

function param(name) {
  return new URLSearchParams(location.search).get(name);
}

function emptyRow(cols, message) {
  return `<tr><td colspan="${cols}" class="empty">${esc(message)}</td></tr>`;
}

// Disables a button while an async action runs
async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Please wait…';
  try { return await fn(); } finally { button.disabled = false; button.textContent = label; }
}

// One-time message carried to the next page (e.g. "Listing saved")
function flash(message, type = 'success') {
  try { sessionStorage.setItem('flash', JSON.stringify({ message, type })); } catch (e) { /* ignore */ }
}
function showFlash(target) {
  try {
    const f = JSON.parse(sessionStorage.getItem('flash') || 'null');
    sessionStorage.removeItem('flash');
    if (f) showAlert(target, f.message, f.type);
  } catch (e) { /* ignore */ }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
