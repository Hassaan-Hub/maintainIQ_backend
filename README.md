# MaintainIQ Backend

REST API for MaintainIQ, an asset and maintenance-management system. It tracks
assets (with QR codes), lets any user report maintenance issues, supports
technician assignment and a status workflow with a full audit trail, and exposes
an admin dashboard with statistics and maintenance planning.

## Stack

- Node.js (CommonJS) + Express 5
- MongoDB + Mongoose
- JWT authentication stored in an HttpOnly cookie (Bearer header also accepted)
- `qrcode` for on-demand QR image generation
- Built-in `node:test` runner for tests (no extra test dependencies)

## Project structure

```
backend/
  server.js                     # entry point: connects DB, starts HTTP server
  src/
    app.js                      # express app, CORS, route mounting, error handling
    config/db.js                # Mongo connection helper
    config/imagekit.js          # ImageKit signing/delete helpers (built-in crypto + fetch)
    models/                     # Mongoose schemas
    controllers/                # request handlers
    routes/                     # express routers
    middleware/                 # auth + role guards + rate limiters
  scripts/create-admin.js       # bootstrap the first admin account
  scripts/seed-demo.js          # idempotent demo data (10 DEMO- assets)
  tests/                        # node:test integration suite
  docs/API.md                   # full endpoint reference
```

## Requirements

- Node.js 18+ (uses the built-in `fetch`; tested on Node 24)
- A MongoDB database (local or Atlas)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file from the template:

   ```bash
   cp .env.example .env
   ```

3. Fill in the values (see the next section).

4. Start the server:

   ```bash
   npm run dev          # node --watch (no restart helper needed)
   # or
   npm start            # nodemon
   ```

   The API is served on `http://localhost:${PORT}` (default `3000`).

## Environment variables

Variable names only — never commit real values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no | HTTP port (default `3000`) |
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Secret used to sign auth tokens |
| `JWT_EXPIRES_IN` | no | Token lifetime (default `1d`) |
| `NODE_ENV` | no | `development` / `production` (controls cookie `Secure`) |
| `FRONTEND_URL` | no | Base URL used in QR links and the CORS origin (default `http://localhost:5173`) |
| `MONGO_TEST_DB` | no | Database name used by the test suite (default `maintainiq_test`) |
| `SEED_DEMO_DB` | no | Database name targeted by `seed-demo` (defaults to the real DB) |
| `AUTH_RATE_LIMIT_*` | no | Auth limiter window/max overrides |
| `PUBLIC_RATE_LIMIT_*` | no | Public lookup limiter window/max overrides |
| `UPLOAD_RATE_LIMIT_*` | no | Upload-signature limiter window/max (default 30/min) |
| `IMAGEKIT_PUBLIC_KEY` | no | ImageKit public key (enables asset images) |
| `IMAGEKIT_PRIVATE_KEY` | no | ImageKit private key (server-side signing/deletion) |
| `IMAGEKIT_URL_ENDPOINT` | no | ImageKit URL endpoint |
| `IMAGEKIT_UPLOAD_FOLDER` | no | Upload folder (default `/maintainiq/assets`) |

## First admin account

Public registration always creates a regular `user`, so the first admin must be
created from the command line (there is no way to self-assign a privileged role
through the API):

```bash
node scripts/create-admin.js <username> <email> <password>
# or
npm run create-admin -- <username> <email> <password>
```

After that, admins create technician/admin accounts through
`POST /api/users`.

## Demo data

`scripts/seed-demo.js` upserts ten clearly-labelled `DEMO-` assets so the app is
not empty on first run. It is idempotent (safe to run repeatedly) and only ever
touches assets whose code starts with `DEMO-`. It needs an existing admin
account to attribute the seed data to; if none exists it prints how to create one
and exits without error.

```bash
npm run seed-demo
# target an isolated database instead of the real one:
SEED_DEMO_DB=maintainiq_seed_verify npm run seed-demo
```

## Roles

| Role | Capabilities |
| --- | --- |
| `user` | Report issues, view/cancel their own requests, view assets and QR codes |
| `technician` | Everything a user can do, plus view and update the status of requests assigned to them |
| `admin` | Full access: manage assets, users, all requests, assignment, dashboard |

## Testing

The suite uses `node:test` and talks to a **separate database** (`MONGO_TEST_DB`,
default `maintainiq_test`) on the same cluster, so your real data is never
touched. Each run creates uniquely-prefixed records and deletes exactly those
records afterwards.

```bash
npm test
```

Run from the `backend/` directory so `.env` is found. If `MONGODB_URI` is
unreachable the tests fail fast with a clear message.

## Deployment (Vercel)

- **Live URL:** https://maintain-iq-backend-dun.vercel.app
- **Project root:** `backend` (entry `server.js`, built with `@vercel/node` per
  `vercel.json`; all paths route to `server.js`).
- The API mounts every route under `/api`, e.g.
  `https://maintain-iq-backend-dun.vercel.app/api/health`.

Environment variables (Project → Settings → Environment Variables, then
redeploy). `NODE_ENV=production` is mandatory — without it the production-only
rules below are skipped (Vercel's `VERCEL_ENV` is also honoured):

| Name | Required | Value / notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `FRONTEND_URL` | yes | `https://maintain-iq-frontend-one.vercel.app` (CORS origin + QR links; the app refuses to start in production without it) |
| `MONGODB_URI` | yes | MongoDB Atlas connection string |
| `JWT_SECRET` | yes | at least 32 characters (the app refuses to start otherwise) |
| `JWT_EXPIRES_IN` | no | e.g. `1d` |
| `IMAGEKIT_PUBLIC_KEY` / `IMAGEKIT_PRIVATE_KEY` / `IMAGEKIT_URL_ENDPOINT` | no | enable asset image uploads; leave unset to disable |
| `IMAGEKIT_UPLOAD_FOLDER` | no | e.g. `/maintainiq/assets` |
| rate-limit `*_RATE_LIMIT_*` | no | only to tune the defaults |

Notes:

- No `Domain` is set on the auth cookie; in production it uses
  `SameSite=None; Secure` because the frontend and backend are different sites
  (`vercel.app` is a public suffix), so cross-origin credentialed requests work.
- Only the single origin in `FRONTEND_URL` is allowed by CORS, so changing the
  frontend domain requires updating this variable and redeploying.
- `PORT` is provided by Vercel and must not be set manually.

## API overview

See [docs/API.md](docs/API.md) for full request/response details. Summary:

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET/POST/PATCH/DELETE /api/assets`, `GET /api/assets/:id/qr`
- `GET /api/uploads/auth` (admin; ImageKit direct-upload credentials)
- `GET /api/public/assets/:assetCode` (unauthenticated QR lookup)
- `GET/POST/PATCH /api/users`, `PATCH /api/users/:id/role` (admin)
- Maintenance requests: create, `my`, `assigned`, admin list, detail, history, update, status, assign, cancel, delete
- `GET /api/dashboard/stats|technicians|recommendations|my-workload`
- `GET /api/health`

## Asset images (ImageKit, optional)

Admins can attach one photo to an asset. Uploads go **directly from the browser
to ImageKit**; the backend only signs short-lived parameters so the private key
never reaches the client. Configure the three `IMAGEKIT_*` values to enable it;
when they are missing, `GET /api/uploads/auth` returns `503` and assets simply
have no image. Nothing else depends on ImageKit.

Upload flow:

1. Admin `GET /api/uploads/auth` → `{ upload: { token, expire, signature, publicKey, urlEndpoint, folder, uploadUrl } }`.
2. Browser `POST`s the file (multipart) to `uploadUrl` with the signed fields.
3. ImageKit returns `{ url, fileId }`; the admin saves both on the asset
   (`imageUrl` shown in the UI, `imageFileId` used only to delete the file).

Replacing or clearing an asset's image deletes the old ImageKit file, and
deleting an asset deletes its file — both best-effort.

## Status workflow

Requests move through `open → in_progress → resolved → closed`, with `cancelled`
as a terminal state. Only legal transitions are accepted; every change is
recorded in the request history with the acting user and a timestamp. History is
written only by the server and cannot be forged by clients.

## Known limitations

- Asset images require ImageKit credentials to be configured; without them the
  upload endpoint reports `503` and assets have no image. Tests mock ImageKit
  (no network calls) and the real API is never hit from the suite.
- Tokens are stateless: logging out clears the cookie but does not revoke an
  already-copied token.
- Requests use hard delete (admin only); use `status: "cancelled"`/`"closed"`
  for logical retirement.
- `GET /api/dashboard/recommendations` is rule-based (due dates and asset
  status) — it is not AI and does not claim to be.
