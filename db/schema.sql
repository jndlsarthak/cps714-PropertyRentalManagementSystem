-- =====================================================================
--  Property Rental Management System (PRMS) - Database Schema (SQLite)
--  Task 1: Users, Properties, Units, Listings, Applications, Leases,
--          Maintenance Requests, Quotes, Payments, Messages, Reviews
--  (+ Sessions, used to keep users logged in)
--  See public/erd.html for the Entity Relationship Diagram.
-- =====================================================================

-- Every person who can log in. The role decides which dashboard they see.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,                       -- scrypt "salt:hash", never the plain password
  role          TEXT    NOT NULL CHECK (role IN ('admin','owner','manager','tenant','staff','contractor')),
  status        TEXT    NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Suspended')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Logged-in sessions (cookie token -> user).
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A building/house registered by a Landlord/Owner.
-- manager_id NULL means "the owner manages it themselves".
CREATE TABLE IF NOT EXISTS properties (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  manager_id  INTEGER          REFERENCES users(id),
  address     TEXT    NOT NULL,
  city        TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  num_units   INTEGER NOT NULL CHECK (num_units > 0),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Individual rentable units inside a property.
CREATE TABLE IF NOT EXISTS units (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_number TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'Vacant' CHECK (status IN ('Vacant','Occupied')),
  UNIQUE (property_id, unit_number)
);

-- An advertisement for a vacant unit. 'Leased' = an application was approved.
CREATE TABLE IF NOT EXISTS listings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id     INTEGER NOT NULL REFERENCES units(id),
  created_by  INTEGER NOT NULL REFERENCES users(id),
  rent        REAL    NOT NULL CHECK (rent > 0),
  bedrooms    INTEGER NOT NULL CHECK (bedrooms >= 0),
  description TEXT    NOT NULL,
  image_url   TEXT,
  status      TEXT    NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive','Leased')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

-- A tenant's rental application. One application per tenant per listing.
CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id   INTEGER NOT NULL REFERENCES listings(id),
  tenant_id    INTEGER NOT NULL REFERENCES users(id),
  income       REAL    NOT NULL,          -- monthly income
  employer     TEXT    NOT NULL,
  move_in_date TEXT    NOT NULL,
  message      TEXT,
  status       TEXT    NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Declined')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT,
  UNIQUE (listing_id, tenant_id)
);

-- Created automatically when an application is approved.
CREATE TABLE IF NOT EXISTS leases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id        INTEGER NOT NULL REFERENCES units(id),
  tenant_id      INTEGER NOT NULL REFERENCES users(id),
  application_id INTEGER          REFERENCES applications(id),
  start_date     TEXT    NOT NULL,
  end_date       TEXT    NOT NULL,
  monthly_rent   REAL    NOT NULL,
  deposit        REAL    NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Ended')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A tenant's maintenance request (a "work order" once assigned).
CREATE TABLE IF NOT EXISTS maintenance_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id      INTEGER NOT NULL REFERENCES units(id),
  tenant_id    INTEGER NOT NULL REFERENCES users(id),
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  urgency      TEXT    NOT NULL CHECK (urgency IN ('Low','Medium','High')),
  status       TEXT    NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted','Assigned','Completed')),
  assigned_to  INTEGER          REFERENCES users(id),   -- Maintenance Staff or Contractor
  assigned_at  TEXT,
  completed_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Price quotes submitted by staff/contractors for a work order.
CREATE TABLE IF NOT EXISTS quotes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   INTEGER NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  amount       REAL    NOT NULL CHECK (amount > 0),
  notes        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Simulated rent/deposit payments (only the last 4 card digits are stored).
CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES users(id),
  lease_id   INTEGER NOT NULL REFERENCES leases(id),
  amount     REAL    NOT NULL CHECK (amount > 0),
  type       TEXT    NOT NULL CHECK (type IN ('Rent','Deposit')),
  card_last4 TEXT,
  reference  TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'Paid',
  paid_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Direct messages between a tenant and their property manager.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  body        TEXT    NOT NULL,
  sent_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  read_at     TEXT
);

-- A property manager's rating of a contractor for one completed job.
CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL UNIQUE REFERENCES maintenance_requests(id),
  contractor_id INTEGER NOT NULL REFERENCES users(id),
  reviewer_id   INTEGER NOT NULL REFERENCES users(id),
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_properties_owner   ON properties(owner_id);
CREATE INDEX IF NOT EXISTS idx_properties_manager ON properties(manager_id);
CREATE INDEX IF NOT EXISTS idx_units_property     ON units(property_id);
CREATE INDEX IF NOT EXISTS idx_listings_unit      ON listings(unit_id);
CREATE INDEX IF NOT EXISTS idx_applications_tenant ON applications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_maint_assigned     ON maintenance_requests(assigned_to);
CREATE INDEX IF NOT EXISTS idx_messages_pair      ON messages(sender_id, receiver_id);
