# Engineering Decisions

This document explains the design choices behind Newtonite Ops, why each was made, and what was
traded away. The focus is on the areas the brief says matter most: concurrency, server-side
authorization, reliable history, idempotency, workflow validation and tests.

## 1. Stack

| Choice | Why | Trade-off |
|---|---|---|
| **PostgreSQL** | The hard requirements (no double-claim, atomic change + history, no skipped states) are *consistency* problems. Transactions, row locks, CHECK constraints, triggers and partial indexes solve them in the database, where they cannot be bypassed by a buggy code path. | Needs a server (vs. SQLite/Mongo). |
| **`pg` + hand-written SQL instead of Prisma** | The correctness story is the SQL: `SELECT … FOR UPDATE OF w`, `UPDATE … WHERE assignee_id IS NULL`, `INSERT … ON CONFLICT DO NOTHING`. An ORM would hide these or force raw queries anyway. Also, Prisma's query/migration engines could not be downloaded in the environment this was built in, so I could not have run or tested it. | More boilerplate, no generated types. A migration to Prisma/Drizzle is straightforward since the schema is plain SQL. |
| **Express + zod** | Small, well understood; zod gives one place to define and validate request shapes. Unknown fields on PATCH are rejected (`.strict()`). | No automatic OpenAPI. |
| **JWT (8h)** | Stateless, simple for an SPA. Tokens carry only the user id. | No server-side revocation of a stolen token before expiry (see limitations). |
| **One deployable** | Express serves the built React app, so there is no CORS or second host to configure. | Frontend and API scale together. |

## 2. Authorization (server-side only)

* Roles are **per team** (`memberships(user_id, team_id, role)`), so a user can be Admin of one team and Viewer of another.
* Roles are **not stored in the JWT**. Every request loads the user, and every item operation loads the caller's role *in the item's team*. A demotion or removal therefore takes effect on the next request (tested).
* A single hierarchy (`viewer < member < lead < admin`) lives in `rbac.js`; each endpoint states the minimum role it needs.
* **List queries enforce access in SQL** (`team_id IN (SELECT team_id FROM memberships WHERE user_id = $1)`), so a missing check cannot leak rows.
* **Non-members get 404, not 403**, for items and teams, so the existence of other teams' data is not revealed. Malformed ids also return 404 rather than a database error.
* The API returns a `capabilities` object per item (`canEdit`, `canClaim`, `transitionRules`, …) so the UI can hide buttons, but this is **only a hint**: every action is re-checked on the server (the tests hit the API directly, bypassing the UI).
* Ownership rules: a Member may edit/move only items they created or hold; a Lead may act on any item in the team.
* **Four-eyes approval**: the assignee cannot approve their own work (an Admin may, so a one-person team is not deadlocked).
* Passwords: bcrypt. Login returns the same error for unknown email and wrong password.

## 3. Workflow

`Open → In Progress → Awaiting Approval → Resolved → Closed`, defined once as a transition table in
`workflow.js` (target state, minimum role, ownership requirement, whether a reason is needed).

Besides the forward path there are three controlled backward moves, each realistic for operations work:
*pause* (In Progress → Open), *reject* (Awaiting Approval → In Progress, reason required) and *reopen*
(Resolved → In Progress, reason required). **Closed is terminal** and cannot be edited or reassigned
(comments are still allowed for post-mortem notes).

Rules enforced on the server: no skipping steps; work cannot start on an unassigned item; only Leads+ approve, close or send back.
A **database CHECK constraint** (`active_items_have_assignee`) backs this up: even a bug or a manual SQL
update cannot leave an In Progress / Awaiting Approval item without an owner.

*Trade-off:* the transition table is in code, not the database. It would be possible to enforce it with a trigger, but
that makes rules harder to evolve and test; the row lock (below) already makes the check race-free.

## 4. Concurrency

Three different races, three different tools. Every state-changing request runs in **one transaction**
(`mutation.js`) at READ COMMITTED; the change and its activity rows commit or roll back together.

### 4.1 Two people claim the same item → atomic compare-and-set

```sql
UPDATE work_items SET assignee_id = $1, version = version + 1
 WHERE id = $2 AND assignee_id IS NULL AND status IN ('open','in_progress','awaiting_approval')
```

The `WHERE` clause is the guard. A concurrent claimer blocks on the row lock until the first
transaction commits, then re-evaluates the condition against the committed row, matches 0 rows and gets
`409 ALREADY_ASSIGNED` with the winner's name. No application-level lock, no read-then-write gap.
Test: 20 users claim at once → exactly 1 success, 19 conflicts, exactly one history row, version 2.

### 4.2 Two people edit / move from stale screens → row lock + optimistic version

Edits, assignment and transitions first `SELECT … FOR UPDATE OF w` the item, so concurrent writers to the
same item are **serialised**, then compare the client's `version` with the locked row:

* `PATCH` and `assign` **require** `version`; a mismatch returns `409 VERSION_CONFLICT` containing the current item, so the UI can show "someone else changed this" instead of silently overwriting (lost update).
* `transition` takes an optional `version`; even without it, the lock plus the transition table guarantee two simultaneous approvals cannot both succeed (the second sees `resolved → resolved`, which is not a valid move).

I chose *both* techniques deliberately: pessimistic locking gives correctness for the short critical section; the version gives the *user* a meaningful signal that what they were looking at is out of date.

### 4.3 The same request is sent twice → idempotency keys

Clients may send `Idempotency-Key: <uuid>` on any write (the web UI always does; a "Create" modal reuses
one key until it succeeds, so a retry after a network failure cannot create a second item).

The key row is inserted **inside the same transaction** as the change, with `INSERT … ON CONFLICT DO NOTHING` on `(user_id, key)`:

* first request: inserts the key, performs the change, stores the response, commits;
* retry after commit: the insert does nothing → the stored response is replayed (`Idempotent-Replayed: true`) and business tables are untouched;
* **simultaneous duplicates**: the second insert blocks on the unique index until the first transaction finishes, then behaves like a retry (10 parallel identical creates → 1 row, tested);
* a request that **fails** rolls back, key included, so it can be retried after the cause is fixed;
* same key with a **different payload or endpoint** → `422 IDEMPOTENCY_KEY_REUSED` rather than returning an unrelated response;
* keys are scoped per user and purged after 24h.

Without a key, requests behave normally (a second identical create creates a second item). Making keys
mandatory would be stricter, but it would break simple API clients; the trade-off is documented rather than hidden.

### 4.4 Team administration races

Demoting/removing an admin locks all admin rows of the team (`FOR UPDATE`) before counting, so two admins
demoting each other at the same moment cannot leave a team with zero admins (tested).

### 4.5 Why READ COMMITTED (not SERIALIZABLE)

Each race above is handled by an explicit lock or a conditional write on a single row, which keeps
transactions short and avoids serialization-failure retry loops. SERIALIZABLE would also work but would
need retry logic in every endpoint for no extra safety here.

## 5. Activity history

* Table `activity` records: created, status, priority, assignee, other field edits, comments, with actor, timestamp and old/new values.
* Rows are written **in the same transaction** as the change, so history cannot disagree with state: a rolled-back change leaves no history (tested), and a committed change always has its history.
* The table is **append-only at the database level**: a trigger rejects `UPDATE` and direct `DELETE` (tested). Cascades from deleting a parent row remain possible.
* Assignee values are stored as user ids (stable if someone renames); names are resolved when reading.
* Long text (description edits) records *that* the field changed, not the full before/after, to avoid duplicating large content.
* Automatic changes are also logged: removing or demoting a member returns their open items to the pool *and writes history explaining why*.

## 6. API and data design

* Resource-style REST; actions that are not plain CRUD (`claim`, `assign`, `transition`) are explicit POST endpoints, because they carry business rules and concurrency semantics that a generic `PATCH status` would blur.
* Consistent error envelope with stable machine-readable codes; `409` for conflicts, `422` for valid-but-not-allowed, `403` for role, `404` for missing/no access.
* Indexes: `(team_id, status)`, partial index on `assignee_id`, partial index on *urgent & unassigned* (the dashboard's hot query).
* `ILIKE` search escapes `%` and `_`; SQL is always parameterised; `helmet`, a 100 kB body limit and `strict()` schemas reduce attack surface.
* Dashboard is computed on the server with role-aware flags (`canClaim`, `canApprove`) so the UI never guesses.

## 7. Testing approach

* Jest + Supertest against **real PostgreSQL** (schema recreated from the real migration on each run). Mocks would hide the locking behaviour the tests exist to verify.
* Concurrency tests fire genuinely parallel requests (`Promise.all`) from many users and assert on both the HTTP results *and* the database (row counts, final state, history chain).
* The tests were **mutation-checked**: temporarily removing the claim guard or the row lock makes the relevant tests fail.
* Where two outcomes are both legal serialisations (approve vs. reject), the test asserts the *invariant* (history forms an unbroken chain ending in the final status) instead of a single order, so it is not flaky.
* The browser flow (claim race between two real browser sessions, approve from the dashboard, read-only viewer) was exercised end-to-end manually/with a headless browser, but is not part of the automated suite.

## 8. Known limitations and what I would do next

* **No automated frontend tests**; the UI was verified with a scripted headless-browser run, not committed tests. Next: Playwright smoke tests in CI.
* **JWT in `localStorage`**: simple, but exposed to XSS. A production system would use an httpOnly cookie with CSRF protection and refresh-token rotation. There is no server-side token revocation or logout-everywhere.
* **No login rate limiting / lockout** and open self-registration. Next: `express-rate-limit` plus per-account backoff, and optional email verification/invites (currently an Admin adds an already-registered user by email).
* **No real-time updates**: the UI refetches after actions and reports conflicts when you try to act on stale data; it does not push other users' changes. Next: SSE/WebSocket for live dashboards.
* **Offset pagination** for lists and no pagination for an item's activity log; fine at this scale, keyset pagination would be next.
* **Idempotency is opt-in** per request and keys expire after 24h.
* **Workflow is fixed** in code; per-team custom workflows would need a data-driven design.
* **No SLA timers, notifications, attachments, or full-text search** (simple `ILIKE`).
* **Roles are per team only**; there is no global super-admin.
* **Seed script is for demos**; passwords are intentionally well-known and must not be used in production.
* The test suite wipes the `public` schema of the test database; it guards against running on a non-"test" database name but you should still point it at a disposable database.
