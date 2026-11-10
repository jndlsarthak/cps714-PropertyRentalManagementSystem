// =====================================================================
//  Task 2: Sample data. Runs automatically the first time the server
//  starts (when the users table is empty). Every account's password is
//  "password123".
// =====================================================================

const DAY = 24 * 60 * 60 * 1000;
const date = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const dateTime = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 19).replace('T', ' ');

function seed(db, hashPassword) {
  const insert = (sql, ...params) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const password = hashPassword('password123');

  // ---------- Users ----------
  const U = {};
  const users = [
    ['admin', 'Alice Admin', 'admin@prms.com', 'admin'],
    ['owner', 'Olivia Owner', 'owner@prms.com', 'owner'],
    ['owner2', 'Oscar Owner', 'owner2@prms.com', 'owner'],
    ['manager', 'Mark Manager', 'manager@prms.com', 'manager'],
    ['manager2', 'Mia Manager', 'manager2@prms.com', 'manager'],
    ['tenant', 'Tom Tenant', 'tenant@prms.com', 'tenant'],
    ['tenant2', 'Tina Tenant', 'tenant2@prms.com', 'tenant'],
    ['tenant3', 'Ravi Tenant', 'tenant3@prms.com', 'tenant'],
    ['staff', 'Steve Staff', 'staff@prms.com', 'staff'],
    ['contractor', 'Carl Contractor', 'contractor@prms.com', 'contractor'],
    ['contractor2', 'Cora Contractor', 'contractor2@prms.com', 'contractor'],
  ];
  for (const [key, name, email, role] of users) {
    U[key] = insert('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      name, email, password, role, dateTime(-400));
  }
  U.suspended = insert("INSERT INTO users (name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'tenant', 'Suspended', ?)",
    'Sue Suspended', 'suspended@prms.com', password, dateTime(-90));

  // ---------- Properties + Units ----------
  const P = {};
  const units = {};
  const properties = [
    ['maple', U.owner, U.manager, '12 Maple Street', 'Toronto', 'Apartment', 4],
    ['lake', U.owner, U.manager2, '88 Lakeshore Blvd', 'Toronto', 'Condo', 2],
    ['king', U.owner, U.manager, '240 King Street W', 'Waterloo', 'Apartment', 3],
    ['oak', U.owner2, null, '5 Oak Avenue', 'Ottawa', 'House', 1], // owner manages it themselves
    ['elm', U.owner2, U.manager, '77 Elm Road', 'Ottawa', 'Townhouse', 2],
  ];
  for (const [key, owner, manager, address, city, type, count] of properties) {
    P[key] = insert('INSERT INTO properties (owner_id, manager_id, address, city, type, num_units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      owner, manager, address, city, type, count, dateTime(-380));
    for (let n = 1; n <= count; n++) {
      units[`${key}${n}`] = insert('INSERT INTO units (property_id, unit_number) VALUES (?, ?)', P[key], String(n));
    }
  }

  // ---------- Listings ----------
  const L = {};
  const img = (seedWord) => `https://picsum.photos/seed/${seedWord}/640/400`;
  const listings = [
    ['maple1', 'maple1', U.manager, 1850, 2, 'Bright 2-bedroom with a renovated kitchen, in-suite laundry and a balcony overlooking the park.', 'Leased'],
    ['maple2', 'maple2', U.manager, 1650, 1, 'Cozy 1-bedroom near the subway. Hardwood floors, heat and water included.', 'Active'],
    ['maple3', 'maple3', U.manager, 2100, 2, 'Corner unit with large windows, two full bathrooms and a parking spot.', 'Active'],
    ['lake1', 'lake1', U.manager2, 2400, 2, 'Lakeview condo with gym, pool and 24h concierge.', 'Leased'],
    ['lake2', 'lake2', U.manager2, 2600, 2, 'High-floor 2-bedroom with panoramic lake views and an underground parking space.', 'Active'],
    ['king1', 'king1', U.manager, 1500, 1, 'Modern 1-bedroom steps from the university and tech park.', 'Active'],
    ['king2', 'king2', U.manager, 1950, 3, 'Spacious 3-bedroom, ideal for students sharing. Currently being repainted.', 'Inactive'],
    ['oak1', 'oak1', U.owner2, 2800, 3, 'Detached family house with a backyard, garage and finished basement.', 'Active'],
    ['elm1', 'elm1', U.manager, 2200, 3, 'End-unit townhouse with 2.5 baths, a private patio and a quiet street.', 'Active'],
  ];
  for (const [key, unitKey, creator, rent, beds, desc, status] of listings) {
    L[key] = insert('INSERT INTO listings (unit_id, created_by, rent, bedrooms, description, image_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      units[unitKey], creator, rent, beds, desc, img(`prms-${key}`), status, dateTime(-250));
  }

  // ---------- Applications ----------
  const app = (listing, tenant, income, employer, moveIn, msg, status, createdDays) =>
    insert('INSERT INTO applications (listing_id, tenant_id, income, employer, move_in_date, message, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      L[listing], tenant, income, employer, moveIn, msg, status, dateTime(createdDays), status === 'Pending' ? null : dateTime(createdDays + 2));

  const tomApp = app('maple1', U.tenant, 6200, 'Northwind Logistics', date(-200), 'Non-smoker, no pets. Happy to provide references.', 'Approved', -215);
  const raviApp = app('lake1', U.tenant3, 7400, 'City Hospital', date(-330), 'Looking for a long-term lease.', 'Approved', -345);
  app('maple2', U.tenant2, 4800, 'Bluebird Cafe', date(20), 'I work nearby and would love a short commute.', 'Pending', -3);
  app('oak1', U.tenant2, 4800, 'Bluebird Cafe', date(30), 'Is the backyard fenced? I have a small dog.', 'Pending', -1);
  app('maple3', U.tenant3, 7400, 'City Hospital', date(-300), 'Second choice if the lake condo is taken.', 'Declined', -344);

  // ---------- Leases (units become Occupied) ----------
  const tomLease = insert("INSERT INTO leases (unit_id, tenant_id, application_id, start_date, end_date, monthly_rent, deposit, status) VALUES (?, ?, ?, ?, ?, 1850, 1850, 'Active')",
    units.maple1, U.tenant, tomApp, date(-200), date(165));
  const raviLease = insert("INSERT INTO leases (unit_id, tenant_id, application_id, start_date, end_date, monthly_rent, deposit, status) VALUES (?, ?, ?, ?, ?, 2400, 2400, 'Active')",
    units.lake1, U.tenant3, raviApp, date(-330), date(35));
  db.prepare("UPDATE units SET status = 'Occupied' WHERE id IN (?, ?)").run(units.maple1, units.lake1);

  // ---------- Maintenance requests, quotes, reviews ----------
  const req = (unit, tenant, title, desc, urgency, status, assignee, createdDays, completedDays) =>
    insert('INSERT INTO maintenance_requests (unit_id, tenant_id, title, description, urgency, status, assigned_to, assigned_at, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      units[unit], tenant, title, desc, urgency, status, assignee,
      assignee ? dateTime(createdDays + 1) : null,
      completedDays != null ? dateTime(completedDays) : null, dateTime(createdDays));
  const quote = (request, by, amount, notes, days) =>
    insert('INSERT INTO quotes (request_id, submitted_by, amount, notes, created_at) VALUES (?, ?, ?, ?, ?)', request, by, amount, notes, dateTime(days));

  req('maple1', U.tenant, 'Leaking kitchen faucet', 'The kitchen faucet drips constantly, even when fully closed.', 'Medium', 'Submitted', null, -2, null);

  const heater = req('maple1', U.tenant, 'Heater not working', 'The bedroom radiator stays cold. The other rooms are fine.', 'High', 'Assigned', U.staff, -5, null);
  quote(heater, U.staff, 180, 'Replace the thermostatic valve and bleed the radiator.', -4);

  const latch = req('maple1', U.tenant, 'Broken window latch', 'The living room window latch is broken and the window will not lock.', 'Low', 'Completed', U.contractor, -40, -30);
  quote(latch, U.contractor, 120, 'New latch hardware + 1 hour labour.', -38);
  insert('INSERT INTO reviews (request_id, contractor_id, reviewer_id, rating, comment, created_at) VALUES (?, ?, ?, 4, ?, ?)',
    latch, U.contractor, U.manager, 'Quick and tidy work.', dateTime(-29));

  const drain = req('lake1', U.tenant3, 'Clogged bathroom drain', 'The bathtub drains very slowly.', 'Medium', 'Completed', U.contractor2, -20, -15);
  quote(drain, U.contractor2, 95, 'Snake the drain and clear the trap.', -18);

  const dishwasher = req('lake1', U.tenant3, 'Dishwasher not draining', 'The dishwasher leaves standing water after every cycle.', 'High', 'Completed', U.contractor, -60, -52);
  quote(dishwasher, U.contractor, 700, 'Replace the drain pump (initial estimate).', -58);
  quote(dishwasher, U.contractor, 650, 'Revised: pump part was cheaper than expected.', -56);
  insert('INSERT INTO reviews (request_id, contractor_id, reviewer_id, rating, comment, created_at) VALUES (?, ?, ?, 5, ?, ?)',
    dishwasher, U.contractor, U.manager2, 'Excellent, fixed in one visit.', dateTime(-50));

  req('lake1', U.tenant3, 'Hallway light flickering', 'The hallway ceiling light flickers on and off.', 'Low', 'Assigned', U.contractor, -3, null);

  // ---------- Payments ----------
  const pay = (tenant, lease, amount, type, days) =>
    insert("INSERT INTO payments (tenant_id, lease_id, amount, type, card_last4, reference, status, paid_at) VALUES (?, ?, ?, ?, '4242', ?, 'Paid', ?)",
      tenant, lease, amount, type, 'PAY-' + Math.random().toString(36).slice(2, 10).toUpperCase(), dateTime(days));
  pay(U.tenant, tomLease, 1850, 'Deposit', -205);
  for (const d of [-200, -170, -140, -110, -80, -50, -20]) pay(U.tenant, tomLease, 1850, 'Rent', d);
  pay(U.tenant3, raviLease, 2400, 'Deposit', -335);
  for (const d of [-90, -60, -30]) pay(U.tenant3, raviLease, 2400, 'Rent', d);

  // ---------- Messages ----------
  const msg = (from, to, body, days, read = true) =>
    insert('INSERT INTO messages (sender_id, receiver_id, body, sent_at, read_at) VALUES (?, ?, ?, ?, ?)', from, to, body, dateTime(days), read ? dateTime(days) : null);
  msg(U.tenant, U.manager, 'Hi Mark, the heater in my bedroom has stopped working. I submitted a request.', -5);
  msg(U.manager, U.tenant, 'Thanks Tom, I have assigned Steve from our maintenance team. He will contact you shortly.', -4.9);
  msg(U.tenant, U.manager, 'Great, thank you!', -4.8);
  msg(U.tenant3, U.manager2, 'Hello Mia, my lease ends soon. Could we discuss a renewal?', -1, false);
}

module.exports = { seed };
