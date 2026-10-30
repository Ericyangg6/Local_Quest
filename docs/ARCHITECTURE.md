# Local Quest architecture

Status (2026-10-30): one Next.js app plus Snowflake. Verified locally (mock and live
Snowflake); not yet deployed in this form.

## Components

```
Browser ──► Next.js app (web/, Vercel)
              ├─ pages, Auth.js sign-in, server actions
              ├─ quest planner (src/lib/quest-planner.ts)
              │     └─ Snowflake SQL REST API (src/lib/snowflake.ts, key-pair JWT, role LQ_APP_RO)
              │           ├─ CALL LOCAL_QUEST.APP.FIND_QUEST_LOCATIONS  (candidate places)
              │           └─ SELECT AI_COMPLETE(...)                    (Cortex llama3.3-70b)
              └─ MongoDB (accounts, sessions' users, saved quests, check-ins, avatars)
```

| Component | Responsibility | Lives in |
|---|---|---|
| Web app | Screens, sign-in, quest planning, check-ins, progress | `web/` |
| Quest planner | Reads the player's request, gets candidates, has the model pick stops, builds and checks the schedule | `web/src/lib/quest-planner.ts` |
| Snowflake client | Runs bound SQL statements through the SQL REST API | `web/src/lib/snowflake.ts` |
| Place catalog and search | OpenStreetMap places, hours, cost estimates, ranking procedure | `snowflake/` |
| Account storage | MongoDB collections and indexes | `data/ACCOUNTS.md` |

## Quest planning flow

1. The server action checks the session, validates the message (1–2000 characters), and
   applies a per-player limit (10 quests per 10 minutes).
2. **Cortex call 1:** extract `desiredTime`, `desiredBudget`, `locationPreference` from the
   message. Code normalizes them: missing or invalid → 90 min, $30, `"random"`; travel is
   always `"drive"`.
3. **Snowflake:** `FIND_QUEST_LOCATIONS(preferences, campus address)` returns up to 10 open
   places with closing time, category cost estimate, coordinates, distance, and match reasons.
   Code skips malformed or duplicate rows.
4. If every place is closed, or none has a known cost within budget, return
   `NO_FEASIBLE_ROUTE` (proven) without another model call.
5. **Cortex call 2:** the model returns `{"stops":[{"id", "description"}]}`: candidate
   numbers in visiting order plus a short description. Each candidate has a random task
   chosen by code beforehand.
6. **Code builds the schedule:** straight-line miles × 1.3 at 25 mph (minimum 3 min per
   leg), 20 minutes per stop. In the model's order, it drops any pick that is unknown,
   repeated, unpriced, over budget, closes before departure, or would make the outing
   (including the drive home) exceed the time limit. Missing or overlong descriptions get
   template text. No stops left → `NO_FEASIBLE_ROUTE` (not proven).
7. The validated route is saved to MongoDB and shown. Quests start and end at Cal Poly Pomona.

Errors carry a code (`NO_FEASIBLE_ROUTE`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`,
`UPSTREAM_INVALID_RESPONSE`, `CONFIGURATION_ERROR`, `INTERNAL_ERROR`), a message safe to show
players, and a request ID that also appears in the server log. See `contracts/quest-api.md`.

## Modes
`QUEST_PLANNER=mock` (default) uses fictional demo places and a keyword picker, then runs the
same schedule code; routes are labeled "Demo". `QUEST_PLANNER=snowflake` is live. Production
refuses mock unless `ALLOW_MOCK_IN_PRODUCTION=true`.

## Authentication and accounts
Auth.js v5 with Google and username/password. Accounts in MongoDB via
`@auth/mongodb-adapter` (`data/ACCOUNTS.md`). Sessions are encrypted JWT cookies (httpOnly,
SameSite=Lax, Secure on HTTPS, 30 days): a session can't be revoked early, and rotating
`AUTH_SECRET` signs everyone out. Passwords use Argon2id (19 MiB, t=2, p=1). Google accounts
are never linked automatically to a password account with the same email. Rate limits are in
memory per instance, so they are best effort on serverless hosting.

## Decisions
- **2026-10-23** Next.js App Router + Auth.js replaced the Vite SPA (Auth.js needs Next.js).
- **2026-10-23** Quests start and end at Cal Poly Pomona and are planned for driving.
- **2026-10-30** The FastAPI service (`api/`, on Render) was merged into the Next.js app.
  Reason: one use case did not justify a second deployment, a shared token, duplicated
  validation and rate limits, and a ports/adapters layer. The Python logic was ported to
  TypeScript with equivalent tests.
- **2026-10-30** Snowflake is called through its SQL REST API with a key-pair JWT, not the
  `snowflake-sdk` driver. Reason: no dependencies (the driver brings AWS/Azure/GCP SDKs),
  nothing to keep open between serverless invocations, and the Cortex Agents REST API (phase 3
  of `REFACTOR-PLAN.md`) uses the same login.
- **2026-10-30** The model no longer writes arrival times, distances, or totals, and there is
  no repair round. Code computes the schedule from Snowflake's coordinates and keeps the picks
  that fit. Fewer model calls; times are consistent by construction.

## Open questions
- Drive times are estimates, not routed; there is no routing provider.
- Near campus few places have OSM opening hours or cost estimates (parks have no cost, so a
  $0 quest finds nothing). See `REFACTOR-PLAN.md` phase 2 for more data.
- Rate limits should move to a shared store if abuse becomes a problem.
