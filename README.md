# Newtonite Ops

A full-stack operations management app. Teams create, assign, track and resolve work items
(incidents, customer issues, payments, compliance tasks) through an approval workflow, with a
complete activity history and safe behaviour when several people act on the same item at once.

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router, Vite |
| Backend | Node.js 20+, Express 4 |
| Database | PostgreSQL 13+ (plain SQL migrations, `pg` driver) |
| Auth | JWT (bcrypt password hashes) |
| Validation | zod |
| Tests | Jest + Supertest against a real PostgreSQL database |

> **Why `pg` and not Prisma?** The concurrency design relies on explicit transactions,
> `SELECT … FOR UPDATE`, conditional `UPDATE … WHERE` guards, CHECK constraints and a trigger.
> These are written directly in SQL so they are visible and testable. See `ENGINEERING_DECISIONS.md`.

## Features

| # | Requirement | Where |
|---|---|---|
| 1 | Login, teams, roles Viewer / Member / Lead / Admin (per team) | `server/src/routes/auth.js`, `teams.js` |
| 2 | Create, edit, assign, claim, comment on work items | `server/src/routes/items.js` |
| 3 | Workflow Open → In Progress → Awaiting Approval → Resolved → Closed | `server/src/workflow.js` |
| 4 | Activity history (status, priority, assignee, edits, comments) | `server/src/activity.js`, `activity` table |
| 5 | Dashboard: assigned to me, urgent unassigned, awaiting approval | `server/src/routes/dashboard.js` |
| 6 | Authorization enforced on the server from the caller's role in the item's team | `server/src/rbac.js`, every route |
| 7 | Concurrency: atomic claim, row locks, optimistic versioning, idempotency keys | `items.js`, `mutation.js` |
| 8 | 54 automated tests | `server/tests/` |

## Roles

| Role | Can do |
|---|---|
| **Viewer** | Read everything in the team. No writes. |
| **Member** | Create items, comment, claim unassigned items, edit items they created or hold, move their own items Open → In Progress → Awaiting Approval, release their own open claim. |
| **Lead** | Everything a Member can, on any item. Assign/reassign, approve (Awaiting Approval → Resolved), reject, reopen, close. A Lead cannot approve work assigned to themselves. |
| **Admin** | Everything a Lead can, plus manage team members and roles. May approve own work. |

Non-members get **404** (not 403) for a team's items, so existence is not leaked.

## Run locally

Requirements: Node 20+, PostgreSQL 13+.

```bash
# 1. databases (one for the app, one for tests)
createdb newtonite
createdb newtonite_test

# 2. configure
cp server/.env.example server/.env        # edit DATABASE_URL / JWT_SECRET if needed

# 3. install, migrate, seed
npm run install:all
npm run migrate
npm run seed                              # demo users + 14 sample items (optional)

# 4. start (two terminals for hot reload)
npm run dev:server                        # API on http://localhost:4000
npm run dev:client                        # UI  on http://localhost:5173 (proxies /api)
```

Or run as one process, the way it is deployed:

```bash
npm run build      # builds the React app into client/dist
npm start          # Express serves the API and the built UI on http://localhost:4000
```

### Demo accounts (after `npm run seed`)

Password for all: `Password123!`

| Email | Role (in both teams unless noted) |
|---|---|
| admin@demo.com | Admin |
| lead@demo.com | Lead |
| alice@demo.com | Member |
| bob@demo.com | Member (Payments Ops only) |
| viewer@demo.com | Viewer |

Tip: sign in as two different users in two browsers and click **Claim** on the same item at the same
time. One wins; the other gets "Already claimed by …".

## Tests

```bash
npm test
```

The test run **drops and recreates the `public` schema** of `TEST_DATABASE_URL`
(default `postgres://postgres:postgres@localhost:5432/newtonite_test`) and refuses to run if the
database name does not contain "test". Tests run serially against real PostgreSQL, because mocking
the database would hide exactly the bugs they exist to catch.

What is covered (54 tests):

- **Authentication**: bad/missing tokens, no account enumeration, duplicate emails, hashes never returned.
- **Permissions**: every role against every write operation; non-member 404s; per-team roles; privilege-escalation attempts; "last admin" rule; role changes effective immediately; members removed → items released.
- **Workflow**: the full happy path, skipped steps, assignee required, ownership, approval rights, four-eyes rule, reasons required for reject/reopen, closed is terminal, DB constraint backstop.
- **Activity**: every tracked change with actor and old/new values, nothing recorded for failed actions, append-only enforced by a DB trigger.
- **Concurrency**: 20 simultaneous claims → exactly 1 winner; double-click claims; claim vs assign race; two edits from the same version; two simultaneous approvals; approve vs reject; parallel comments.
- **Idempotency**: retry replays the stored response; 10 simultaneous identical creates → 1 row; same key with a different payload → 422; keys scoped per user; failed requests do not burn the key.

I also verified the tests have teeth: removing the claim guard or the row lock makes them fail.

## API summary

All routes are under `/api`, JSON, `Authorization: Bearer <jwt>` except register/login.
Write requests accept an optional `Idempotency-Key` header (8–200 chars); the web UI always sends one.

| Method & path | Purpose |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `GET /auth/me` | Accounts |
| `GET/POST /teams`, `GET/POST /teams/:id/members`, `PATCH/DELETE /teams/:id/members/:userId` | Teams and membership (Admin) |
| `GET /items?teamId&status&priority&type&assignee&q&page` | List (only teams you belong to) |
| `POST /items`, `GET /items/:id`, `PATCH /items/:id` | Create / read with history / edit (needs `version`) |
| `POST /items/:id/claim` | Atomically claim an unassigned item |
| `POST /items/:id/assign` | Assign / reassign / unassign (Lead+; needs `version`) |
| `POST /items/:id/transition` | `{ to, comment?, version? }` |
| `POST /items/:id/comments` | Add a comment |
| `GET /dashboard` | The three dashboard queues + status counts |

Errors: `{ "error": { "code", "message", "details" } }`. `409` = conflict (`VERSION_CONFLICT`,
`ALREADY_ASSIGNED`, `INVALID_TRANSITION`, …), `422` = well-formed but not allowed, `403` = role, `404` = not found / no access.

## Deploy (Render)

`render.yaml` is a Blueprint: one web service (API + built UI) and one free PostgreSQL database.

1. Push the repo to GitHub, then Render → **New → Blueprint** → select the repo.
2. Render builds with `npm run install:all && npm run build` and starts with `npm start`
   (migrations run automatically on boot). `JWT_SECRET` is generated for you.
3. Optional demo data: in the Render shell run `npm run seed`.

Railway / any host: provide `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production` (and `DATABASE_SSL=true` if the database requires TLS).

## Repository layout

```
server/
  migrations/001_init.sql   schema, constraints, indexes, append-only trigger
  scripts/                  migrate.js, seed.js
  src/
    app.js server.js        Express app, boot (runs migrations)
    auth.js rbac.js         JWT + role hierarchy
    workflow.js             the status state machine (single source of truth)
    mutation.js             transaction + idempotency wrapper for every write
    activity.js             audit-trail helpers
    routes/                 auth, teams, items, dashboard
  tests/                    Jest + Supertest
client/                     React app (Vite)
```

## Known limitations

See the end of `ENGINEERING_DECISIONS.md`.
