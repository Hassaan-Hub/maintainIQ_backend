# MaintainIQ API Reference

Base URL: `http://localhost:<PORT>` (default `3000`).

All endpoints return JSON. Authentication uses an HttpOnly cookie named `token`
(set by login) or an `Authorization: Bearer <jwt>` header.

## Conventions

- Success responses: `2xx` with a JSON body such as `{ "message": "...", "<resource>": {...} }`.
- List responses include `pagination: { page, limit, total, pages }`.
- Error responses are always `{ "message": "..." }`.
- Status codes: `400` validation error, `401` unauthenticated, `403` forbidden,
  `404` not found, `409` duplicate, `413` payload too large, `429` rate limited,
  `500` unexpected error, `503` feature not configured, `200/201` success.
- `page` defaults to `1`; `limit` defaults to `10` and is capped at `100`.
- `:id` values must be valid Mongo ObjectIds (otherwise `400`).

## Roles

`user` < `technician` < `admin`. Public registration always creates a `user`.
Privileged accounts are created by admins via `POST /api/users`.

---

## Health

### `GET /api/health` — public

`200` → `{ "status": "ok", "message": "MaintainIQ backend is running." }`

---

## Authentication

### `POST /api/auth/register` — public

Body: `{ username, email, password }`. Role is always `user`.

- `201` → `{ "message", "user": { id, username, email, role } }`
- `400` invalid input, `409` username/email already used.

### `POST /api/auth/login` — public

Body: `{ email, password }`. Sets the `token` HttpOnly cookie.

- `200` → `{ "message", "user": { id, username, email, role } }`
- `401` invalid credentials.

### `POST /api/auth/logout` — public

Clears the auth cookie. `200` → `{ "message" }`.

### `GET /api/auth/me` — any authenticated user

`200` → `{ "user": { id, username, email, role } }`; `401` if missing/invalid/expired token.

---

## Users (admin only)

All routes require the `admin` role (`401` unauthenticated, `403` otherwise).

### `POST /api/users`

Body: `{ username, email, password, role? }` where `role` ∈ `user|technician|admin` (default `user`).

- `201` → `{ "message", "user": { id, username, email, role, createdAt } }`
- `400` invalid input/role, `409` duplicate.

### `GET /api/users`

Query: `role`, `search` (username/email), `page`, `limit`.

`200` → `{ "users": [...], "pagination": {...} }`

### `PATCH /api/users/:id/role`

Body: `{ role }`. Admins cannot change their own role.

- `200` → `{ "message", "user": {...} }`
- `400` invalid id/role or self-change, `404` user not found.

---

## Assets

### `POST /api/assets` — admin

Body: `{ name, assetCode, category, location, description?, status?, imageUrl?, imageFileId? }`,
`status` ∈ `active|maintenance|retired` (default `active`). `imageUrl` (≤500 chars)
and `imageFileId` (≤100 chars) are optional and normally come from the upload
flow below.

- `201` → `{ "message", "asset": {...} }`
- `400` validation, `409` duplicate `assetCode` (case-insensitive).

### `GET /api/assets` — any authenticated user

Query: `search`, `status`, `category`, `location`, `page`, `limit`.

`200` → `{ "assets": [...], "pagination": {...} }`

### `GET /api/assets/:id` — any authenticated user

`200` → `{ "asset": {...} }`; `400` invalid id, `404` not found.

### `PATCH /api/assets/:id` — admin

Body: any of `name, category, location, description, status, imageUrl, imageFileId`.
`assetCode` and `createdBy` are immutable. Replacing or clearing `imageFileId`
deletes the previous ImageKit file (best-effort).

- `200` → `{ "message", "asset": {...} }`
- `400` validation/empty update, `404` not found.

### `DELETE /api/assets/:id` — admin

Hard delete. Any attached ImageKit file is removed (best-effort).
`200` → `{ "message" }`; `409` if the asset still has maintenance requests;
`404` not found.

### `GET /api/assets/:id/qr` — any authenticated user

`200` → `{ "assetCode", "url", "qrDataUrl" }` where `qrDataUrl` is a
`data:image/png;base64,...` string pointing at `` `${FRONTEND_URL}/assets/<assetCode>` ``.

### `GET /api/public/assets/:assetCode` — public

Minimal public lookup used after scanning a QR code. Returns only
`{ assetCode, name, category, location, status, description, imageUrl }`.

`200` → `{ "asset": {...} }`; `404` unknown code.

---

## Uploads (ImageKit, admin only)

Images are uploaded straight from the browser to ImageKit; the backend only
hands out short-lived, signed parameters and keeps the private key on the server.
All upload routes require the `admin` role (`401` unauthenticated, `403`
otherwise) and are rate-limited per IP (`UPLOAD_RATE_LIMIT_MAX`, default 30/min).

Setup: set `IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_PRIVATE_KEY` and
`IMAGEKIT_URL_ENDPOINT` (optionally `IMAGEKIT_UPLOAD_FOLDER`). When they are
absent, uploads are disabled and the endpoint returns `503` — assets still work
without images.

### `GET /api/uploads/auth` — admin

Returns the one-time parameters needed to upload a file directly to ImageKit.
The signature is `HMAC-SHA1(token + expire)` keyed by the private key and is
valid for 30 minutes.

- `200` → `{ "upload": { "token", "expire", "signature", "publicKey", "urlEndpoint", "folder", "uploadUrl" } }`
- `503` ImageKit is not configured.

The browser then `POST`s multipart form data to `uploadUrl` with
`file, fileName, publicKey, signature, expire, token, folder, useUniqueFileName`.
ImageKit replies with `{ "url", "fileId", ... }`; send `url` as `imageUrl` and
`fileId` as `imageFileId` when creating or updating an asset.

---

## Maintenance requests

Statuses: `open`, `in_progress`, `resolved`, `closed`, `cancelled`.
Priorities: `low`, `medium`, `high`, `critical`.
Legal transitions: `open→in_progress|resolved|closed|cancelled`,
`in_progress→open|resolved|closed|cancelled`, `resolved→in_progress|closed`,
`closed→open`, `cancelled` is terminal.

A request JSON looks like:

```json
{
  "id": "...",
  "asset": { "id": "...", "name": "...", "assetCode": "...", "category": "...", "location": "...", "status": "active" },
  "reportedBy": { "id": "...", "username": "...", "role": "user" },
  "assignedTechnician": { "id": "...", "username": "...", "role": "technician" },
  "title": "...", "description": "...", "category": "...", "location": "...",
  "priority": "medium", "status": "open",
  "dueDate": null, "resolvedAt": null, "closedAt": null,
  "createdAt": "...", "updatedAt": "..."
}
```

### `POST /api/maintenance-requests` — any authenticated user

Body: `{ asset, title, description, priority?, category?, location?, dueDate? }`.

`reportedBy` is taken from the token and `status` is forced to `open`
(client-supplied `reportedBy`, `status`, `assignedTechnician` and `history` are ignored).
`category`/`location` default to the asset's values.

- `201` → `{ "message", "request": {...} }`
- `400` invalid asset id/missing fields/invalid priority/date, `404` asset not found.

### `GET /api/maintenance-requests/my` — any authenticated user

Own requests only. Query: `status`, `priority`, `page`, `limit`.

`200` → `{ "requests": [...], "pagination": {...} }`

### `GET /api/maintenance-requests/assigned` — technician or admin

A technician sees only requests assigned to them. An admin sees all assignments
(optional `technicianId`, `status`, `priority`, `page`, `limit`). Regular users get `403`.

### `GET /api/maintenance-requests` — admin

Query: `search` (title/description/category/location), `status`, `priority`,
`asset`, `assignedTechnician`, `category`, `location`, `page`, `limit`.

`200` → `{ "requests": [...], "pagination": {...} }`

### `GET /api/maintenance-requests/:id` — admin, reporter, or assigned technician

Others receive `404` (no information leak). `400` invalid id, `404` not found.

### `GET /api/maintenance-requests/:id/history` — admin, reporter, or assigned technician

`200` → `{ "history": [ { "action", "from", "to", "note", "by": { id, username, role }, "at" } ] }`

Actions: `created`, `status_changed`, `priority_changed`, `assigned`,
`unassigned`, `updated`, `cancelled`. History is server-written only.

### `PATCH /api/maintenance-requests/:id` — admin

Body: any of `title, description, category, location, dueDate, priority, status`.
`asset` and `reportedBy` are immutable. Empty/unknown-only bodies → `400`;
illegal status transitions → `400`.

`200` → `{ "message", "request": {...} }`

### `PATCH /api/maintenance-requests/:id/status` — assigned technician or admin

Body: `{ status, note? }`. Technicians may only act on requests assigned to them
and cannot set `cancelled`. Illegal transitions → `400`; no-op → `400`;
unassigned/unrelated technician → `403`.

`200` → `{ "message", "request": {...} }`

### `PATCH /api/maintenance-requests/:id/assign` — admin

Body: `{ technicianId }` (an ObjectId, or `null`/`""` to unassign). The target
must exist and have the `technician` role. Assignment cannot change on `closed`
or `cancelled` requests.

- `200` → `{ "message", "request": {...} }`
- `400` invalid/missing technicianId, non-technician target, same technician,
  no technician to unassign, or closed/cancelled request; `404` request/technician not found.

### `PATCH /api/maintenance-requests/:id/cancel` — reporter or admin

Body: `{ note? }`. Only `open`/`in_progress` requests can be cancelled.
`400` otherwise; `403` if not the reporter/admin; `404` not found.

### `DELETE /api/maintenance-requests/:id` — admin

Deletes the request only (asset and user are untouched). `200`; `404` not found.

---

## Dashboard

### `GET /api/dashboard/stats` — admin

`200` →

```json
{
  "assets": { "total": 0, "byStatus": { "active": 0, "maintenance": 0, "retired": 0 } },
  "requests": {
    "total": 0,
    "byStatus": { "open": 0, "in_progress": 0, "resolved": 0, "closed": 0, "cancelled": 0 },
    "byPriority": { "low": 0, "medium": 0, "high": 0, "critical": 0 },
    "unassigned": 0, "overdue": 0, "upcoming": 0
  }
}
```

### `GET /api/dashboard/technicians` — admin

`200` → `{ "technicians": [ { "technician": { id, username, role }, "total", "open", "in_progress", "resolved" } ] }`

### `GET /api/dashboard/recommendations` — admin

Rule-based maintenance planning (not AI). Overdue/upcoming windows use request
`dueDate`; `assetsInMaintenance` lists assets with `status: "maintenance"`.

`200` → `{ "window": { "days": 7, "generatedAt" }, "overdue": {...}, "upcoming": {...}, "assetsInMaintenance": {...} }`

### `GET /api/dashboard/my-workload` — technician or admin

`200` → `{ "technicianId", "total", "open", "in_progress", "resolved" }`.
Admins may pass `?technicianId=` to inspect a specific technician.

---

## Fallbacks

- Unknown routes → `404 { "message": "Route not found." }`
- Malformed JSON body → `400 { "message": "Invalid JSON payload." }`
- Unexpected server error → `500 { "message": "Something went wrong. Please try again." }`
