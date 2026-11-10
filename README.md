# Property Rental Management System

A web app for managing rental properties. Admins, owners, property managers, tenants, maintenance staff and contractors all log in from the same page and each see their own dashboard.

Built with HTML, CSS and JavaScript on the frontend and Node.js with SQLite on the backend.

## Running it

You need Node.js 22.13 or newer.

```
node server.js
```

Then open http://localhost:3000.

The database is created with sample data the first time you run it. To reset it:

```
node server.js --reset
```

## Test accounts

The password for all accounts is `password123`.

| Role | Email |
|---|---|
| Admin | admin@prms.com |
| Owner | owner@prms.com |
| Owner (manages own property) | owner2@prms.com |
| Property Manager | manager@prms.com |
| Tenant | tenant@prms.com |
| Maintenance Staff | staff@prms.com |
| Contractor | contractor@prms.com |
| Suspended user | suspended@prms.com |

## Files

- `server.js` - backend and API
- `db/schema.sql` - database tables
- `db/seed.js` - sample data
- `public/` - all the pages, plus `css/` and `js/`
- `public/erd.html` - database diagram
