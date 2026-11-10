// =====================================================================
//  Property Rental Management System - server
//  Plain Node.js: built-in http + built-in SQLite. No npm packages.
//
//  Run:    node server.js            -> http://localhost:3000
//  Reset:  node server.js --reset    (deletes the database and reloads sample data)
// =====================================================================
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { seed } = require('./db/seed');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = path.join(__dirname, 'data', 'prms.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 8;

// ---------------------------------------------------------------------
//  Database setup
// ---------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (process.argv.includes('--reset') && fs.existsSync(DB_FILE)) {
  fs.rmSync(DB_FILE);
  console.log('Database deleted. Sample data will be reloaded.');
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));

const nulls = (params) => params.map((p) => (p === undefined ? null : p));
const all = (sql, ...p) => db.prepare(sql).all(...nulls(p));
const get = (sql, ...p) => db.prepare(sql).get(...nulls(p));
const run = (sql, ...p) => db.prepare(sql).run(...nulls(p));

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------
//  Passwords (Task 4: stored hashed with scrypt + random salt)
// ---------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

if (get('SELECT COUNT(*) AS n FROM users').n === 0) {
  transaction(() => seed(db, hashPassword));
  console.log('Sample data loaded.');
}

// ---------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------
const ROLES = ['admin', 'owner', 'manager', 'tenant', 'staff', 'contractor'];
const MGR = ['manager', 'owner']; // owners act as manager for self-managed properties
const WORKERS = ['staff', 'contractor'];
// SQL condition: "this property is managed by user ?" (owner manages it if no manager is assigned)
const MANAGES = 'COALESCE(p.manager_id, p.owner_id) = ?';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function text(value, field, { required = true, max = 1000 } = {}) {
  const s = (value ?? '').toString().trim();
  if (required && !s) fail(400, `${field} is required.`);
  if (s.length > max) fail(400, `${field} must be at most ${max} characters.`);
  return s;
}

function number(value, field, { min, max, integer = false } = {}) {
  if (value === '' || value === null || value === undefined) fail(400, `${field} is required.`);
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) fail(400, `${field} must be a ${integer ? 'whole ' : ''}number.`);
  if (min !== undefined && n < min) fail(400, `${field} must be at least ${min}.`);
  if (max !== undefined && n > max) fail(400, `${field} must be at most ${max}.`);
  return n;
}

function oneOf(value, field, options) {
  if (!options.includes(value)) fail(400, `${field} must be one of: ${options.join(', ')}.`);
  return value;
}

function isoDate(value, field) {
  const s = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) fail(400, `${field} must be a valid date.`);
  return s;
}

const today = () => new Date().toISOString().slice(0, 10);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status });

// ---------------------------------------------------------------------
//  Sessions (Task 7)
// ---------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns the logged-in, *active* user or null. Suspended users are rejected here too.
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  return get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND u.status = 'Active' AND s.created_at > datetime('now', ?)`,
    token, `-${SESSION_HOURS} hours`
  ) || null;
}

// ---------------------------------------------------------------------
//  Tiny router
// ---------------------------------------------------------------------
const routes = [];
// roles: null = public, 'any' = any logged-in user, [..] = only these roles
function route(method, pattern, roles, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
  routes.push({ method, regex, keys, roles, handler });
}

// =====================================================================
//  AUTH  (Stories 2 & 18)
// =====================================================================
route('POST', '/api/login', null, ({ body, res }) => {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) fail(400, 'Please enter your email and password.');

  const user = get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(password, user.password_hash)) fail(401, 'Invalid email or password.');
  if (user.status === 'Suspended') fail(403, 'Your account has been suspended. Please contact the administrator.');

  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, user.id);
  run("DELETE FROM sessions WHERE created_at <= datetime('now', ?)", `-${SESSION_HOURS} hours`);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`);
  return { user: publicUser(user) };
});

route('POST', '/api/logout', null, ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/me', 'any', ({ user }) => {
  const me = publicUser(user);
  me.unread = get('SELECT COUNT(*) AS n FROM messages WHERE receiver_id = ? AND read_at IS NULL', user.id).n;
  if (user.role === 'owner') {
    me.selfManaged = get('SELECT COUNT(*) AS n FROM properties WHERE owner_id = ? AND manager_id IS NULL', user.id).n;
  }
  return { user: me };
});

// Role-specific numbers for the dashboard (Task 8)
route('GET', '/api/dashboard', 'any', ({ user }) => {
  const n = (sql, ...p) => get(sql, ...p).n ?? 0;
  const id = user.id;
  const unread = n('SELECT COUNT(*) AS n FROM messages WHERE receiver_id = ? AND read_at IS NULL', id);
  let stats = [];

  if (user.role === 'admin') {
    stats = [
      { label: 'Total users', value: n('SELECT COUNT(*) AS n FROM users') },
      { label: 'Suspended users', value: n("SELECT COUNT(*) AS n FROM users WHERE status = 'Suspended'") },
      { label: 'Active listings', value: n("SELECT COUNT(*) AS n FROM listings WHERE status = 'Active'") },
      { label: 'Open maintenance requests', value: n("SELECT COUNT(*) AS n FROM maintenance_requests WHERE status != 'Completed'") },
    ];
  } else if (user.role === 'owner') {
    const units = get(
      `SELECT COUNT(*) AS total, SUM(u.status = 'Occupied') AS occupied
       FROM units u JOIN properties p ON p.id = u.property_id WHERE p.owner_id = ?`, id);
    stats = [
      { label: 'Properties', value: n('SELECT COUNT(*) AS n FROM properties WHERE owner_id = ?', id) },
      { label: 'Occupied units', value: `${units.occupied || 0} / ${units.total || 0}` },
      { label: 'Vacant units', value: (units.total || 0) - (units.occupied || 0) },
      { label: 'Self-managed properties', value: n('SELECT COUNT(*) AS n FROM properties WHERE owner_id = ? AND manager_id IS NULL', id) },
    ];
  }

  if (MGR.includes(user.role)) {
    const managed = [
      { label: 'Active listings', value: n(`SELECT COUNT(*) AS n FROM listings l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id WHERE l.status = 'Active' AND ${MANAGES}`, id) },
      { label: 'Pending applications', value: n(`SELECT COUNT(*) AS n FROM applications a JOIN listings l ON l.id = a.listing_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id WHERE a.status = 'Pending' AND ${MANAGES}`, id) },
      { label: 'New maintenance requests', value: n(`SELECT COUNT(*) AS n FROM maintenance_requests m JOIN units u ON u.id = m.unit_id JOIN properties p ON p.id = u.property_id WHERE m.status = 'Submitted' AND ${MANAGES}`, id) },
      { label: 'Unread messages', value: unread },
    ];
    // Only show manager numbers to owners who manage something themselves
    if (user.role === 'manager' || n('SELECT COUNT(*) AS n FROM properties WHERE owner_id = ? AND manager_id IS NULL', id) > 0) {
      stats = stats.concat(managed);
    }
  } else if (user.role === 'tenant') {
    stats = [
      { label: 'Active leases', value: n("SELECT COUNT(*) AS n FROM leases WHERE tenant_id = ? AND status = 'Active'", id) },
      { label: 'Pending applications', value: n("SELECT COUNT(*) AS n FROM applications WHERE tenant_id = ? AND status = 'Pending'", id) },
      { label: 'Open maintenance requests', value: n("SELECT COUNT(*) AS n FROM maintenance_requests WHERE tenant_id = ? AND status != 'Completed'", id) },
      { label: 'Unread messages', value: unread },
    ];
  } else if (WORKERS.includes(user.role)) {
    stats = [
      { label: 'Open work orders', value: n("SELECT COUNT(*) AS n FROM maintenance_requests WHERE assigned_to = ? AND status = 'Assigned'", id) },
      { label: 'Completed jobs', value: n("SELECT COUNT(*) AS n FROM maintenance_requests WHERE assigned_to = ? AND status = 'Completed'", id) },
      { label: 'Quotes submitted', value: n('SELECT COUNT(*) AS n FROM quotes WHERE submitted_by = ?', id) },
    ];
    if (user.role === 'contractor') {
      const r = get('SELECT ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM reviews WHERE contractor_id = ?', id);
      stats.push({ label: 'Average rating', value: r.n ? `${r.avg} ★ (${r.n})` : 'No ratings yet' });
    }
  }
  return { stats };
});

// =====================================================================
//  ADMIN  (Stories 1, 17, 18)
// =====================================================================
route('POST', '/api/users', ['admin'], ({ body }) => {
  const name = text(body.name, 'Name', { max: 100 });
  const email = text(body.email, 'Email', { max: 200 }).toLowerCase();
  const password = String(body.password || '');
  const role = body.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
  if (password.length < 6) fail(400, 'Password must be at least 6 characters.');
  oneOf(role, 'Role', ROLES);
  if (get('SELECT id FROM users WHERE email = ?', email)) fail(409, 'A user with this email already exists.');

  const info = run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', name, email, hashPassword(password), role);
  return { user: publicUser(get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)) };
});

route('GET', '/api/users', ['admin'], () => ({
  users: all('SELECT id, name, email, role, status, created_at FROM users ORDER BY created_at DESC, id DESC'),
}));

route('POST', '/api/users/:id/status', ['admin'], ({ user, params, body }) => {
  const status = oneOf(body.status, 'Status', ['Active', 'Suspended']);
  if (params.id === user.id) fail(400, 'You cannot change the status of your own account.');
  const target = get('SELECT * FROM users WHERE id = ?', params.id);
  if (!target) fail(404, 'User not found.');
  run('UPDATE users SET status = ? WHERE id = ?', status, params.id);
  if (status === 'Suspended') run('DELETE FROM sessions WHERE user_id = ?', params.id); // log them out immediately
  return { ok: true };
});

route('GET', '/api/admin/listings', ['admin'], () => ({
  listings: all(`
    SELECT l.id, l.rent, l.bedrooms, l.status, l.created_at, u.unit_number, p.address, p.city,
           COALESCE(m.name, o.name) AS manager_name,
           (SELECT COUNT(*) FROM applications a WHERE a.listing_id = l.id) AS applications
    FROM listings l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    JOIN users o ON o.id = p.owner_id
    LEFT JOIN users m ON m.id = p.manager_id
    ORDER BY l.created_at DESC, l.id DESC`),
}));

route('GET', '/api/admin/maintenance', ['admin'], () => ({
  requests: all(`
    SELECT m.id, m.title, m.urgency, m.status, m.created_at, m.completed_at,
           u.unit_number, p.address, p.city, t.name AS tenant_name,
           w.name AS assignee_name, w.role AS assignee_role,
           (SELECT q.amount FROM quotes q WHERE q.request_id = m.id ORDER BY q.id DESC LIMIT 1) AS latest_quote
    FROM maintenance_requests m
    JOIN units u ON u.id = m.unit_id
    JOIN properties p ON p.id = u.property_id
    JOIN users t ON t.id = m.tenant_id
    LEFT JOIN users w ON w.id = m.assigned_to
    ORDER BY m.created_at DESC, m.id DESC`),
}));

// =====================================================================
//  OWNER  (Stories 3, 10, 20)
// =====================================================================
const PROPERTY_TYPES = ['Apartment', 'House', 'Condo', 'Townhouse', 'Duplex', 'Commercial'];

route('GET', '/api/managers', ['owner'], () => ({
  managers: all("SELECT id, name, email FROM users WHERE role = 'manager' AND status = 'Active' ORDER BY name"),
}));

function checkManager(value) {
  if (value === '' || value === null || value === undefined || value === 'self') return null;
  const id = number(value, 'Property Manager', { integer: true });
  if (!get("SELECT id FROM users WHERE id = ? AND role = 'manager' AND status = 'Active'", id)) fail(400, 'Please choose a valid Property Manager.');
  return id;
}

route('POST', '/api/properties', ['owner'], ({ user, body }) => {
  const address = text(body.address, 'Address', { max: 200 });
  const city = text(body.city, 'City', { max: 100 });
  const type = oneOf(body.type, 'Property type', PROPERTY_TYPES);
  const numUnits = number(body.num_units, 'Number of units', { min: 1, max: 200, integer: true });
  const managerId = checkManager(body.manager_id);

  const propertyId = transaction(() => {
    const info = run('INSERT INTO properties (owner_id, manager_id, address, city, type, num_units) VALUES (?, ?, ?, ?, ?, ?)',
      user.id, managerId, address, city, type, numUnits);
    const id = Number(info.lastInsertRowid);
    const addUnit = db.prepare('INSERT INTO units (property_id, unit_number) VALUES (?, ?)');
    for (let i = 1; i <= numUnits; i++) addUnit.run(id, String(i));
    return id;
  });
  return { id: propertyId };
});

route('GET', '/api/properties/mine', ['owner'], ({ user }) => ({
  properties: all(`
    SELECT p.*, m.name AS manager_name,
           (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.status = 'Occupied') AS occupied
    FROM properties p LEFT JOIN users m ON m.id = p.manager_id
    WHERE p.owner_id = ? ORDER BY p.created_at DESC, p.id DESC`, user.id),
}));

route('POST', '/api/properties/:id/manager', ['owner'], ({ user, params, body }) => {
  if (!get('SELECT id FROM properties WHERE id = ? AND owner_id = ?', params.id, user.id)) fail(404, 'Property not found.');
  run('UPDATE properties SET manager_id = ? WHERE id = ?', checkManager(body.manager_id), params.id);
  return { ok: true };
});

// Task 43: join properties, units and leases + summary counts
route('GET', '/api/owner/occupancy', ['owner'], ({ user }) => {
  const rows = all(`
    SELECT p.id AS property_id, p.address, p.city, u.id AS unit_id, u.unit_number, u.status,
           le.start_date AS lease_start, le.end_date AS lease_end, le.monthly_rent, t.name AS tenant_name
    FROM properties p
    JOIN units u ON u.property_id = p.id
    LEFT JOIN leases le ON le.unit_id = u.id AND le.status = 'Active'
    LEFT JOIN users t ON t.id = le.tenant_id
    WHERE p.owner_id = ?
    ORDER BY p.address, CAST(u.unit_number AS INTEGER), u.unit_number`, user.id);
  const summary = get(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(u.status = 'Occupied'), 0) AS occupied,
           COALESCE(SUM(u.status = 'Vacant'), 0) AS vacant
    FROM units u JOIN properties p ON p.id = u.property_id WHERE p.owner_id = ?`, user.id);
  return { rows, summary };
});

// Task 50: sum of completed jobs' quotes per property.
// If a job has several quotes, the most recent one is the final price.
const FINAL_QUOTE = '(SELECT q2.id FROM quotes q2 WHERE q2.request_id = m.id ORDER BY q2.id DESC LIMIT 1)';
route('GET', '/api/owner/spending', ['owner'], ({ user }) => {
  const properties = all(`
    SELECT p.id, p.address, p.city,
           COUNT(DISTINCT m.id) AS completed_jobs,
           COALESCE(SUM(q.amount), 0) AS total_spent
    FROM properties p
    LEFT JOIN units u ON u.property_id = p.id
    LEFT JOIN maintenance_requests m ON m.unit_id = u.id AND m.status = 'Completed'
    LEFT JOIN quotes q ON q.id = ${FINAL_QUOTE}
    WHERE p.owner_id = ?
    GROUP BY p.id
    ORDER BY total_spent DESC, p.address`, user.id);
  const jobs = all(`
    SELECT m.id, m.title, m.completed_at, p.address, u.unit_number, w.name AS done_by, w.role AS done_by_role, q.amount
    FROM maintenance_requests m
    JOIN units u ON u.id = m.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN users w ON w.id = m.assigned_to
    LEFT JOIN quotes q ON q.id = ${FINAL_QUOTE}
    WHERE p.owner_id = ? AND m.status = 'Completed'
    ORDER BY m.completed_at DESC`, user.id);
  return { properties, jobs };
});

// =====================================================================
//  LISTINGS  (Stories 4, 5, 6)
// =====================================================================
const LISTING_SELECT = `
  SELECT l.*, u.unit_number, u.status AS unit_status, p.id AS property_id, p.address, p.city, p.type,
         COALESCE(p.manager_id, p.owner_id) AS manager_id, mg.name AS manager_name
  FROM listings l
  JOIN units u ON u.id = l.unit_id
  JOIN properties p ON p.id = u.property_id
  JOIN users mg ON mg.id = COALESCE(p.manager_id, p.owner_id)`;

function managedListing(id, user) {
  const listing = get(`${LISTING_SELECT} WHERE l.id = ? AND ${MANAGES}`, id, user.id);
  if (!listing) fail(404, 'Listing not found.');
  return listing;
}

function listingFields(body) {
  const imageUrl = text(body.image_url, 'Image URL', { required: false, max: 500 });
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) fail(400, 'Image URL must start with http:// or https://');
  return {
    rent: number(body.rent, 'Monthly rent', { min: 1, max: 100000 }),
    bedrooms: number(body.bedrooms, 'Bedrooms', { min: 0, max: 20, integer: true }),
    description: text(body.description, 'Description', { max: 2000 }),
    image_url: imageUrl || null,
  };
}

// Units the manager can create a listing for
route('GET', '/api/managed/units', MGR, ({ user }) => ({
  units: all(`
    SELECT u.id, u.unit_number, u.status, p.address, p.city,
           (SELECT COUNT(*) FROM listings l WHERE l.unit_id = u.id AND l.status = 'Active') AS active_listings
    FROM units u JOIN properties p ON p.id = u.property_id
    WHERE ${MANAGES}
    ORDER BY p.address, CAST(u.unit_number AS INTEGER)`, user.id),
}));

// Task 13: save listing with status "Active"
route('POST', '/api/listings', MGR, ({ user, body }) => {
  const unitId = number(body.unit_id, 'Unit', { integer: true });
  const unit = get(`SELECT u.* FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ? AND ${MANAGES}`, unitId, user.id);
  if (!unit) fail(400, 'Please choose one of your units.');
  if (unit.status !== 'Vacant') fail(400, 'This unit is occupied. Listings can only be created for vacant units.');
  if (get("SELECT id FROM listings WHERE unit_id = ? AND status = 'Active'", unitId)) fail(409, 'This unit already has an active listing.');
  const f = listingFields(body);
  const info = run("INSERT INTO listings (unit_id, created_by, rent, bedrooms, description, image_url, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')",
    unitId, user.id, f.rent, f.bedrooms, f.description, f.image_url);
  return { id: Number(info.lastInsertRowid) };
});

route('GET', '/api/listings/mine', MGR, ({ user }) => ({
  listings: all(`
    SELECT l.*, u.unit_number, p.address, p.city,
           (SELECT COUNT(*) FROM applications a WHERE a.listing_id = l.id AND a.status = 'Pending') AS pending_apps
    FROM listings l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
    WHERE ${MANAGES}
    ORDER BY CASE l.status WHEN 'Active' THEN 0 WHEN 'Inactive' THEN 1 ELSE 2 END, l.created_at DESC`, user.id),
}));

// Task 26: UPDATE query
route('PUT', '/api/listings/:id', MGR, ({ user, params, body }) => {
  managedListing(params.id, user);
  const f = listingFields(body);
  run("UPDATE listings SET rent = ?, bedrooms = ?, description = ?, image_url = ?, updated_at = datetime('now') WHERE id = ?",
    f.rent, f.bedrooms, f.description, f.image_url, params.id);
  return { ok: true };
});

// Task 27: deactivate (and re-activate)
route('POST', '/api/listings/:id/status', MGR, ({ user, params, body }) => {
  const listing = managedListing(params.id, user);
  const status = oneOf(body.status, 'Status', ['Active', 'Inactive']);
  if (listing.status === 'Leased') fail(400, 'This listing has already been leased.');
  if (status === 'Active') {
    if (listing.unit_status !== 'Vacant') fail(400, 'The unit is occupied, so the listing cannot be activated.');
    if (get("SELECT id FROM listings WHERE unit_id = ? AND status = 'Active' AND id != ?", listing.unit_id, listing.id)) fail(409, 'Another active listing already exists for this unit.');
  }
  run("UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?", status, params.id);
  return { ok: true };
});

// Tasks 16 & 18: tenants see only Active listings, filtered in the SQL query
route('GET', '/api/listings', ['tenant'], ({ query }) => {
  let sql = `${LISTING_SELECT} WHERE l.status = 'Active'`;
  const params = [];
  const location = (query.get('location') || '').trim();
  if (location) {
    sql += ' AND (p.city LIKE ? OR p.address LIKE ?)';
    params.push(`%${location}%`, `%${location}%`);
  }
  if (query.get('max_price')) {
    sql += ' AND l.rent <= ?';
    params.push(number(query.get('max_price'), 'Max price', { min: 0 }));
  }
  if (query.get('bedrooms')) {
    sql += ' AND l.bedrooms >= ?';
    params.push(number(query.get('bedrooms'), 'Bedrooms', { min: 0, integer: true }));
  }
  sql += ' ORDER BY l.created_at DESC, l.id DESC';
  const cities = all("SELECT DISTINCT p.city FROM listings l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id WHERE l.status = 'Active' ORDER BY p.city").map((r) => r.city);
  return { listings: all(sql, ...params), cities };
});

route('GET', '/api/listings/:id', ['tenant', ...MGR], ({ user, params }) => {
  if (user.role !== 'tenant') return { listing: managedListing(params.id, user) };
  const listing = get(`${LISTING_SELECT} WHERE l.id = ?`, params.id);
  const myApplication = get('SELECT * FROM applications WHERE listing_id = ? AND tenant_id = ?', params.id, user.id);
  // Hidden from tenants unless active (or they already applied to it)
  if (!listing || (listing.status !== 'Active' && !myApplication)) fail(404, 'This listing is not available.');
  return { listing, myApplication: myApplication || null };
});

// =====================================================================
//  APPLICATIONS  (Stories 7, 8, 9)
// =====================================================================
route('POST', '/api/applications', ['tenant'], ({ user, body }) => {
  const listingId = number(body.listing_id, 'Listing', { integer: true });
  const listing = get("SELECT * FROM listings WHERE id = ? AND status = 'Active'", listingId);
  if (!listing) fail(400, 'This listing is no longer accepting applications.');
  if (get('SELECT id FROM applications WHERE listing_id = ? AND tenant_id = ?', listingId, user.id)) {
    fail(409, 'You have already applied to this listing. Check "My Applications" for its status.');
  }
  const income = number(body.income, 'Monthly income', { min: 0, max: 10000000 });
  const employer = text(body.employer, 'Employer', { max: 150 });
  const moveIn = isoDate(body.move_in_date, 'Move-in date');
  if (moveIn < today()) fail(400, 'Move-in date cannot be in the past.');
  const message = text(body.message, 'Message', { required: false, max: 1000 });

  const info = run("INSERT INTO applications (listing_id, tenant_id, income, employer, move_in_date, message, status) VALUES (?, ?, ?, ?, ?, ?, 'Pending')",
    listingId, user.id, income, employer, moveIn, message || null);
  return { id: Number(info.lastInsertRowid) };
});

route('GET', '/api/applications/mine', ['tenant'], ({ user }) => ({
  applications: all(`
    SELECT a.*, l.rent, l.bedrooms, u.unit_number, p.address, p.city
    FROM applications a
    JOIN listings l ON l.id = a.listing_id
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE a.tenant_id = ? ORDER BY a.created_at DESC, a.id DESC`, user.id),
}));

route('GET', '/api/applications/managed', MGR, ({ user }) => ({
  applications: all(`
    SELECT a.*, t.name AS tenant_name, t.email AS tenant_email,
           l.rent, l.bedrooms, l.status AS listing_status, u.unit_number, p.address, p.city
    FROM applications a
    JOIN users t ON t.id = a.tenant_id
    JOIN listings l ON l.id = a.listing_id
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE ${MANAGES}
    ORDER BY CASE a.status WHEN 'Pending' THEN 0 ELSE 1 END, a.created_at DESC`, user.id),
}));

// Tasks 22 & 23: approve/decline; approval creates a lease and marks the unit Occupied
route('POST', '/api/applications/:id/decision', MGR, ({ user, params, body }) => {
  const decision = oneOf(body.decision, 'Decision', ['Approved', 'Declined']);
  const app = get(`
    SELECT a.*, l.unit_id, l.rent, u.status AS unit_status
    FROM applications a
    JOIN listings l ON l.id = a.listing_id
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE a.id = ? AND ${MANAGES}`, params.id, user.id);
  if (!app) fail(404, 'Application not found.');
  if (app.status !== 'Pending') fail(400, `This application was already ${app.status.toLowerCase()}.`);

  if (decision === 'Declined') {
    run("UPDATE applications SET status = 'Declined', decided_at = datetime('now') WHERE id = ?", app.id);
    return { ok: true };
  }

  if (app.unit_status !== 'Vacant') fail(409, 'This unit is already occupied.');
  const leaseId = transaction(() => {
    run("UPDATE applications SET status = 'Approved', decided_at = datetime('now') WHERE id = ?", app.id);
    const startDate = app.move_in_date > today() ? app.move_in_date : today();
    const info = run(`INSERT INTO leases (unit_id, tenant_id, application_id, start_date, end_date, monthly_rent, deposit, status)
                      VALUES (?, ?, ?, ?, date(?, '+1 year', '-1 day'), ?, ?, 'Active')`,
      app.unit_id, app.tenant_id, app.id, startDate, startDate, app.rent, app.rent);
    run("UPDATE units SET status = 'Occupied' WHERE id = ?", app.unit_id);
    run("UPDATE listings SET status = 'Leased', updated_at = datetime('now') WHERE id = ?", app.listing_id);
    // The unit is taken, so the other pending applicants are declined
    run("UPDATE applications SET status = 'Declined', decided_at = datetime('now') WHERE listing_id = ? AND status = 'Pending'", app.listing_id);
    return Number(info.lastInsertRowid);
  });
  return { ok: true, leaseId };
});

// =====================================================================
//  LEASES (used by tenant maintenance + payment pages)
// =====================================================================
route('GET', '/api/tenant/leases', ['tenant'], ({ user }) => ({
  leases: all(`
    SELECT le.*, u.unit_number, p.address, p.city, mg.name AS manager_name,
           (SELECT COALESCE(SUM(amount), 0) FROM payments py WHERE py.lease_id = le.id AND py.type = 'Deposit') AS deposit_paid
    FROM leases le
    JOIN units u ON u.id = le.unit_id
    JOIN properties p ON p.id = u.property_id
    JOIN users mg ON mg.id = COALESCE(p.manager_id, p.owner_id)
    WHERE le.tenant_id = ? AND le.status = 'Active'
    ORDER BY le.start_date DESC`, user.id),
}));

function tenantLease(leaseId, user) {
  const lease = get("SELECT * FROM leases WHERE id = ? AND tenant_id = ? AND status = 'Active'", leaseId, user.id);
  if (!lease) fail(400, 'Please choose one of your active leases.');
  return lease;
}

// =====================================================================
//  MAINTENANCE  (Stories 11, 12, 16, 22)
// =====================================================================
route('POST', '/api/maintenance', ['tenant'], ({ user, body }) => {
  const lease = tenantLease(number(body.lease_id, 'Unit', { integer: true }), user);
  const title = text(body.title, 'Issue title', { max: 150 });
  const description = text(body.description, 'Description', { max: 2000 });
  const urgency = oneOf(body.urgency, 'Urgency', ['Low', 'Medium', 'High']);
  const info = run("INSERT INTO maintenance_requests (unit_id, tenant_id, title, description, urgency, status) VALUES (?, ?, ?, ?, ?, 'Submitted')",
    lease.unit_id, user.id, title, description, urgency);
  return { id: Number(info.lastInsertRowid) };
});

route('GET', '/api/maintenance/mine', ['tenant'], ({ user }) => ({
  requests: all(`
    SELECT m.*, u.unit_number, p.address, w.name AS assignee_name, w.role AS assignee_role
    FROM maintenance_requests m
    JOIN units u ON u.id = m.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN users w ON w.id = m.assigned_to
    WHERE m.tenant_id = ? ORDER BY m.created_at DESC, m.id DESC`, user.id),
}));

route('GET', '/api/maintenance/managed', MGR, ({ user }) => {
  const requests = all(`
    SELECT m.*, u.unit_number, p.address, p.city, t.name AS tenant_name,
           w.name AS assignee_name, w.role AS assignee_role,
           r.rating AS review_rating, r.comment AS review_comment
    FROM maintenance_requests m
    JOIN units u ON u.id = m.unit_id
    JOIN properties p ON p.id = u.property_id
    JOIN users t ON t.id = m.tenant_id
    LEFT JOIN users w ON w.id = m.assigned_to
    LEFT JOIN reviews r ON r.request_id = m.id
    WHERE ${MANAGES}
    ORDER BY CASE m.status WHEN 'Submitted' THEN 0 WHEN 'Assigned' THEN 1 ELSE 2 END,
             CASE m.urgency WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, m.created_at DESC`, user.id);
  // Task 38: all quotes from staff and contractors, attached to each request
  const quotes = all(`
    SELECT q.*, s.name AS submitted_by_name, s.role AS submitted_by_role
    FROM quotes q
    JOIN users s ON s.id = q.submitted_by
    JOIN maintenance_requests m ON m.id = q.request_id
    JOIN units u ON u.id = m.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE ${MANAGES} ORDER BY q.created_at`, user.id);
  for (const r of requests) r.quotes = quotes.filter((q) => q.request_id === r.id);
  return { requests };
});

// Staff + contractors for the "Assign to" dropdown, with contractors' average rating (Task 56)
route('GET', '/api/workers', MGR, () => ({
  workers: all(`
    SELECT w.id, w.name, w.role, ROUND(AVG(r.rating), 1) AS avg_rating, COUNT(r.id) AS review_count
    FROM users w LEFT JOIN reviews r ON r.contractor_id = w.id
    WHERE w.role IN ('staff', 'contractor') AND w.status = 'Active'
    GROUP BY w.id ORDER BY w.role DESC, w.name`),
}));

function managedRequest(id, user) {
  const request = get(`
    SELECT m.*, w.role AS assignee_role FROM maintenance_requests m
    JOIN units u ON u.id = m.unit_id JOIN properties p ON p.id = u.property_id
    LEFT JOIN users w ON w.id = m.assigned_to
    WHERE m.id = ? AND ${MANAGES}`, id, user.id);
  if (!request) fail(404, 'Maintenance request not found.');
  return request;
}

// Task 32: save assignment, status -> Assigned
route('POST', '/api/maintenance/:id/assign', MGR, ({ user, params, body }) => {
  const request = managedRequest(params.id, user);
  if (request.status === 'Completed') fail(400, 'This request is already completed.');
  const workerId = number(body.assignee_id, 'Assignee', { integer: true });
  if (!get("SELECT id FROM users WHERE id = ? AND role IN ('staff','contractor') AND status = 'Active'", workerId)) {
    fail(400, 'Please choose a maintenance staff member or contractor.');
  }
  run("UPDATE maintenance_requests SET assigned_to = ?, status = 'Assigned', assigned_at = datetime('now') WHERE id = ?", workerId, request.id);
  return { ok: true };
});

// Task 55: save rating to Reviews
route('POST', '/api/maintenance/:id/review', MGR, ({ user, params, body }) => {
  const request = managedRequest(params.id, user);
  if (request.status !== 'Completed') fail(400, 'You can only rate a job after it is completed.');
  if (request.assignee_role !== 'contractor') fail(400, 'Only contractors can be rated.');
  if (get('SELECT id FROM reviews WHERE request_id = ?', request.id)) fail(409, 'This job has already been rated.');
  const rating = number(body.rating, 'Rating', { min: 1, max: 5, integer: true });
  const comment = text(body.comment, 'Comment', { required: false, max: 1000 });
  run('INSERT INTO reviews (request_id, contractor_id, reviewer_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
    request.id, request.assigned_to, user.id, rating, comment || null);
  return { ok: true };
});

// =====================================================================
//  WORK ORDERS - Maintenance Staff & Contractors  (Stories 13, 14, 15)
// =====================================================================
route('GET', '/api/workorders/mine', WORKERS, ({ user }) => {
  const orders = all(`
    SELECT m.*, u.unit_number, p.address, p.city, t.name AS tenant_name,
           r.rating AS review_rating, r.comment AS review_comment
    FROM maintenance_requests m
    JOIN units u ON u.id = m.unit_id
    JOIN properties p ON p.id = u.property_id
    JOIN users t ON t.id = m.tenant_id
    LEFT JOIN reviews r ON r.request_id = m.id
    WHERE m.assigned_to = ?
    ORDER BY CASE m.status WHEN 'Assigned' THEN 0 ELSE 1 END,
             CASE m.urgency WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, m.created_at DESC`, user.id);
  const quotes = all('SELECT * FROM quotes WHERE submitted_by = ? ORDER BY created_at', user.id);
  for (const o of orders) o.quotes = quotes.filter((q) => q.request_id === o.id);
  return { orders };
});

function myWorkOrder(id, user) {
  const order = get('SELECT * FROM maintenance_requests WHERE id = ? AND assigned_to = ?', id, user.id);
  if (!order) fail(404, 'Work order not found or not assigned to you.');
  return order;
}

// Tasks 35 & 38: save a quote linked to the work order
route('POST', '/api/workorders/:id/quote', WORKERS, ({ user, params, body }) => {
  const order = myWorkOrder(params.id, user);
  if (order.status === 'Completed') fail(400, 'This work order is already completed.');
  const amount = number(body.amount, 'Amount', { min: 0.01, max: 1000000 });
  const notes = text(body.notes, 'Notes', { required: false, max: 1000 });
  run('INSERT INTO quotes (request_id, submitted_by, amount, notes) VALUES (?, ?, ?, ?)', order.id, user.id, amount, notes || null);
  return { ok: true };
});

// Tasks 36, 40, 41: mark complete + save completion date
route('POST', '/api/workorders/:id/complete', WORKERS, ({ user, params }) => {
  const order = myWorkOrder(params.id, user);
  if (order.status === 'Completed') fail(400, 'This work order is already completed.');
  if (!get('SELECT id FROM quotes WHERE request_id = ? AND submitted_by = ?', order.id, user.id)) {
    fail(400, 'Please submit a quote for this job before marking it as complete.');
  }
  run("UPDATE maintenance_requests SET status = 'Completed', completed_at = datetime('now') WHERE id = ?", order.id);
  return { ok: true };
});

// =====================================================================
//  PAYMENTS (simulated)  (Story 19)
// =====================================================================
route('POST', '/api/payments', ['tenant'], ({ user, body }) => {
  const lease = tenantLease(number(body.lease_id, 'Lease', { integer: true }), user);
  const type = oneOf(body.type, 'Payment type', ['Rent', 'Deposit']);
  const amount = number(body.amount, 'Amount', { min: 1, max: 1000000 });
  text(body.card_name, 'Name on card', { max: 100 });
  const cardNumber = String(body.card_number || '').replace(/[\s-]/g, '');
  if (!/^\d{16}$/.test(cardNumber)) fail(400, 'Card number must be 16 digits.');
  const expiry = String(body.expiry || '').trim();
  const m = /^(\d{2})\/(\d{2})$/.exec(expiry);
  if (!m || +m[1] < 1 || +m[1] > 12) fail(400, 'Expiry must be in MM/YY format.');
  const endOfMonth = new Date(2000 + +m[2], +m[1], 0, 23, 59, 59);
  if (endOfMonth < new Date()) fail(400, 'This card has expired.');
  if (!/^\d{3,4}$/.test(String(body.cvv || ''))) fail(400, 'CVV must be 3 or 4 digits.');

  // No real payment gateway: we just record the payment as "Paid".
  const reference = 'PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const info = run("INSERT INTO payments (tenant_id, lease_id, amount, type, card_last4, reference, status) VALUES (?, ?, ?, ?, ?, ?, 'Paid')",
    user.id, lease.id, amount, type, cardNumber.slice(-4), reference);
  return { payment: get('SELECT * FROM payments WHERE id = ?', info.lastInsertRowid) };
});

route('GET', '/api/payments/mine', ['tenant'], ({ user }) => ({
  payments: all(`
    SELECT py.*, u.unit_number, p.address
    FROM payments py
    JOIN leases le ON le.id = py.lease_id
    JOIN units u ON u.id = le.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE py.tenant_id = ? ORDER BY py.paid_at DESC, py.id DESC`, user.id),
}));

// =====================================================================
//  MESSAGES  (Story 21)
//  Tenants can message the manager of a property they rent or applied to.
//  Managers (and self-managing owners) can message those tenants back.
// =====================================================================
function contactIds(user) {
  let ids = [];
  if (user.role === 'tenant') {
    ids = all(`
      SELECT DISTINCT COALESCE(p.manager_id, p.owner_id) AS id
      FROM properties p JOIN units u ON u.property_id = p.id
      WHERE u.id IN (SELECT unit_id FROM leases WHERE tenant_id = ? AND status = 'Active')
         OR u.id IN (SELECT l.unit_id FROM applications a JOIN listings l ON l.id = a.listing_id WHERE a.tenant_id = ?)`,
      user.id, user.id);
  } else if (MGR.includes(user.role)) {
    ids = all(`
      SELECT le.tenant_id AS id FROM leases le
        JOIN units u ON u.id = le.unit_id JOIN properties p ON p.id = u.property_id
        WHERE le.status = 'Active' AND ${MANAGES}
      UNION
      SELECT a.tenant_id FROM applications a
        JOIN listings l ON l.id = a.listing_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
        WHERE ${MANAGES}`, user.id, user.id);
  }
  // Anyone you already have a conversation with stays in your list
  const history = all('SELECT receiver_id AS id FROM messages WHERE sender_id = ? UNION SELECT sender_id FROM messages WHERE receiver_id = ?', user.id, user.id);
  return [...new Set([...ids, ...history].map((r) => r.id))].filter((id) => id !== user.id);
}

route('GET', '/api/messages/contacts', ['tenant', ...MGR], ({ user }) => {
  const contacts = contactIds(user).map((id) => {
    const c = get('SELECT id, name, role FROM users WHERE id = ?', id);
    const last = get(`SELECT body, sent_at, sender_id FROM messages
                      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
                      ORDER BY id DESC LIMIT 1`, id, user.id, user.id, id);
    c.unread = get('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL', id, user.id).n;
    c.last_body = last ? last.body : null;
    c.last_at = last ? last.sent_at : null;
    return c;
  });
  contacts.sort((a, b) => (b.last_at || '').localeCompare(a.last_at || '') || a.name.localeCompare(b.name));
  return { contacts };
});

route('GET', '/api/messages/:id', ['tenant', ...MGR], ({ user, params }) => {
  if (!contactIds(user).includes(params.id)) fail(403, 'You cannot message this user.');
  run("UPDATE messages SET read_at = datetime('now') WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL", params.id, user.id);
  return {
    contact: get('SELECT id, name, role FROM users WHERE id = ?', params.id),
    messages: all(`SELECT * FROM messages
                   WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
                   ORDER BY sent_at, id`, user.id, params.id, params.id, user.id),
  };
});

route('POST', '/api/messages', ['tenant', ...MGR], ({ user, body }) => {
  const receiverId = number(body.receiver_id, 'Receiver', { integer: true });
  if (!contactIds(user).includes(receiverId)) fail(403, 'You cannot message this user.');
  const messageText = text(body.body, 'Message', { max: 2000 });
  run('INSERT INTO messages (sender_id, receiver_id, body) VALUES (?, ?, ?)', user.id, receiverId, messageText);
  return { ok: true };
});

// =====================================================================
//  HTTP plumbing: API dispatch + static files + page protection (Task 8)
// =====================================================================
// Which roles may open which page. Pages not listed (except public ones) just need a login.
const PUBLIC_PAGES = ['index.html', 'erd.html'];
const PAGE_ROLES = {
  'admin-create-user.html': ['admin'],
  'admin-users.html': ['admin'],
  'admin-listings.html': ['admin'],
  'admin-maintenance.html': ['admin'],
  'owner-add-property.html': ['owner'],
  'owner-properties.html': ['owner'],
  'owner-occupancy.html': ['owner'],
  'owner-spending.html': ['owner'],
  'manager-listings.html': MGR,
  'listing-form.html': MGR,
  'manager-applications.html': MGR,
  'manager-maintenance.html': MGR,
  'listings.html': ['tenant'],
  'listing.html': ['tenant'],
  'my-applications.html': ['tenant'],
  'maintenance-new.html': ['tenant'],
  'my-requests.html': ['tenant'],
  'pay.html': ['tenant'],
  'payments.html': ['tenant'],
  'workorders.html': WORKERS,
  'messages.html': ['tenant', ...MGR],
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new HttpError(413, 'Request too large.'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const match = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
  if (!match) return sendJson(res, 404, { error: 'Not found.' });

  const user = currentUser(req);
  if (match.roles !== null) {
    if (!user) return sendJson(res, 401, { error: 'Please log in.' });
    if (Array.isArray(match.roles) && !match.roles.includes(user.role)) return sendJson(res, 403, { error: 'You do not have access to this.' });
  }

  const values = match.regex.exec(url.pathname).slice(1);
  const params = Object.fromEntries(match.keys.map((k, i) => [k, Number(values[i])]));
  const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
  const result = match.handler({ req, res, user, params, body, query: url.searchParams });
  sendJson(res, 200, result);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found.' });

  if (file.endsWith('.html')) {
    const page = path.relative(PUBLIC_DIR, file);
    const user = currentUser(req);
    if (page === 'index.html' && user) return redirect(res, '/dashboard.html');
    if (!PUBLIC_PAGES.includes(page)) {
      if (!user) return redirect(res, '/index.html');                 // block pages when not logged in
      const roles = PAGE_ROLES[page];
      if (roles && !roles.includes(user.role)) return redirect(res, '/dashboard.html');
    }
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    if (String(err.message).includes('UNIQUE constraint failed')) return sendJson(res, 409, { error: 'This record already exists.' });
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, () => {
  console.log(`PRMS running at http://localhost:${PORT}`);
  console.log('Demo logins (password: password123): admin@prms.com, owner@prms.com, manager@prms.com, tenant@prms.com, staff@prms.com, contractor@prms.com');
});
