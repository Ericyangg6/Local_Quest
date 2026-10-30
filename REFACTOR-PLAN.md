# Simplify Local Quest: merge the API into Next.js, then plan with a Cortex Agent

## Status
- **Phase 1: done locally on 2026-10-30** (branch `simplify-architecture`, not yet deployed). Changes
  from the plan below:
  - Snowflake is called through its SQL REST API with a key-pair JWT (`web/src/lib/snowflake.ts`)
    instead of the `snowflake-sdk` package: no new dependencies, suits serverless functions, and the
    same login works for the Cortex Agents API in phase 3.
  - The types file is `web/src/lib/quest-types.ts`, and the planner returns the understood
    preferences with every result.
  - Doc cleanup also removed `docs/TEAM-CONTRACT.md`, `docs/PLAN.md`, `docs/skills.md`, `.skillls/`,
    `README-SNOWFLAKE-CHAIN-FLAG.md`, `snowflake/PLAN.md` (folded into `snowflake/README.md`), and the
    template `AGENTS.md` files in `contracts/`, `data/`, `tests/`, `snowflake/`.
  - Configuration is one project-wide `.env` (template `.env.example`); `web/next.config.ts` loads it,
    and `web/.env.example` was removed.
  - Docker support (`web/Dockerfile`, `docker-compose.yml`, CI Docker job) was removed: the app is
    hosted only on Vercel.
  - Still to do for phase 1: deploy to Vercel (`docs/Deployment.md`), run the Playwright suite, and
    delete the Render service.
- Phases 2–3: not started.

Three phases, each shipped and verified on its own:
1. Merge FastAPI into Next.js and move schedule math into code (below).
2. One merged place table (OSM + Overture Marketplace) + Cortex Search.
3. A Cortex Agent picks the stops; code re-checks every stop.

# Phase 1: Merge FastAPI into Next.js

## Context
A quest request currently crosses four hosts and a lot of plumbing:

```
Browser → Next.js server action (Vercel) → HTTP + bearer token → FastAPI (Render, Docker)
        → ports/adapters/container/mock layers → Snowflake CALL FIND_QUEST_LOCATIONS + Cortex AI_COMPLETE
        (+ MongoDB Atlas for accounts/quests)
```

For a small hackathon app this is too much: two deploys, a shared secret, CORS/body-limit/rate-limit
middleware duplicated on both sides, a hexagonal architecture (`domain/ports.py`, `container.py`,
`adapters/{llm,mock,snowflake}`) for one use case, and a planning loop where the LLM invents arrival
times and distances that code then validates and sends back for one "repair" attempt.

Target (decided with user): **one Next.js app** that calls Snowflake directly from the server, and a
**simpler planner** where the model only picks/orders stops and writes descriptions, while code
computes the schedule.

```
Browser → Next.js server action → lib/quest-planner → Snowflake (procedure + AI_COMPLETE)
                                                   → MongoDB
```

Kept unchanged: the Snowflake stored procedure `FIND_QUEST_LOCATIONS` and its packaging, Auth.js,
MongoDB schema, all pages/UI, and the `QuestRoute` JSON shape (so already-saved quests still render).

## New planner flow (replaces api/app/services/quest_service.py + domain/route.py)
1. Validate message (already done in `web/src/features/quests/actions.ts`).
2. LLM call 1 — extract preferences (same prompt as `PREFERENCES_SYSTEM` in
   `api/app/adapters/llm/model_adapter.py`), then `normalizePreferences()` (port of
   `api/app/domain/preferences.py`); travelMethod forced to `"drive"`.
3. `CALL LOCAL_QUEST.APP.FIND_QUEST_LOCATIONS(PARSE_JSON(?), ?)` → `parseCandidates()` (port of
   `domain/locations.py`, now also keeping `coordinates` which the procedure already returns).
4. `proveInfeasible()` precheck (all closed / none within budget) → 422 `NO_FEASIBLE_ROUTE`, proven.
5. LLM call 2 — prompt asks only for `{"stops":[{"id": <candidate number 1-10>, "description": "..."}]}`
   in visiting order. Same matching rules as today's `ROUTE_SYSTEM`, minus the time/distance fields.
6. `buildSchedule()` in code: walk the model's order from campus at current local time; leg time =
   haversine miles × 1.3 road factor ÷ 25 mph (min 3 min); 20 min per stop. Skip unknown/duplicate IDs
   and any stop that would break budget, closing time, or the time limit including the drive home.
   Code fills arrival/departure, travelDistance, totalTime, totalDistance, estimatedCost, and a random
   task per stop; bad/missing descriptions fall back to the template text.
7. Zero stops left → 422 `PLANNER_FOUND_NONE` (proven: false). No repair loop — one fewer Cortex call
   and the "model-generated times" limitation in ROUTES.md goes away.

Result type stays `{ ok: true, route } | { ok: false, code, message, requestId, preferences? }`, so
`actions.ts` and `QuestBoard.tsx` barely change.

## Files

### Add (in `web/src/lib/`)
- `snowflake.ts` — `server-only`. Lazy single connection via `snowflake-sdk` (key-pair JWT from
  `SNOWFLAKE_PRIVATE_KEY`, port the PEM-repair logic from `_normalize_pem` in
  `api/app/adapters/snowflake/snowflake_adapter.py`), `execute(sql, binds)` promise wrapper with
  statement timeout, maps errors to `UPSTREAM_UNAVAILABLE` / `UPSTREAM_TIMEOUT`. `aiComplete(prompt)`
  helper = `SELECT AI_COMPLETE(?, ?)` + `extractJson` (port of `chat_client.py`).
- `quest-planner.ts` — the flow above: prompts, `normalizePreferences`, `parseCandidates`,
  `proveInfeasible`, `buildSchedule`, `planQuest(message)`. Pure functions exported for tests;
  Snowflake access passed in as one small `{ complete, findLocations }` object (no ports/container).
- `quest-planner.mock.ts` — offline fixtures used when `QUEST_PLANNER=mock` (default in dev/CI);
  route gets `mock: true` so the existing "demo" label shows. Refuse mock when `NODE_ENV=production`
  unless explicitly allowed (mirrors `ALLOW_MOCK_IN_PRODUCTION`).
- `quest-planner.test.ts` — port the meaningful cases from `api/tests/test_domain.py` /
  `test_service_and_http.py`: preference defaults/overrides/invalid values, candidate parsing (10 unique,
  upper-case keys, bad costs), schedule budget/closing/time-limit/duplicate/unknown-ID handling,
  infeasibility proofs, description fallback, error mapping.

### Change
- `web/src/features/quests/actions.ts` — call `planQuest()` instead of `requestQuestRoute()`; drop
  `RATE_LIMITED`/`retryAfterSeconds` handling (per-player limit in `lib/rate-limit.ts` remains).
- `web/src/lib/quest-api.ts` → keep only the zod `questRouteSchema` + types (rename to
  `quest-types.ts`; update imports in `quests.ts`, `QuestBoard.tsx`, etc.). Delete
  `quest-api.test.ts` HTTP-client cases.
- `web/next.config.ts` — add `snowflake-sdk` to `serverExternalPackages`.
- `web/package.json` — add `snowflake-sdk`.
- `web/src/app/quests/page.tsx` — keep `maxDuration = 120` (Vercel Fluid allows it on Hobby).
- `web/.env.example`, root `.env.example` — remove `QUEST_API_URL/TOKEN`; add `QUEST_PLANNER`,
  `SNOWFLAKE_ACCOUNT/USER/PRIVATE_KEY/ROLE/WAREHOUSE/DATABASE/SCHEMA/AI_MODEL`, `QUEST_TIMEZONE`.
- `docker-compose.yml` — remove the `api` service and token; Snowflake env goes to `web`.
- `.github/workflows/ci.yml` — remove `api` job and API docker build.
- Docs: `README.md`, `docs/ARCHITECTURE.md` (record the decision + rationale), `docs/Deployment.md`
  (Vercel + Atlas only; Snowflake env vars move to Vercel), `docs/PLAN.md`, `contracts/quest-api.md`
  (now documents the planner's internal result/errors rather than an HTTP route).

### Delete
- `api/` (whole folder, incl. `ROUTES.md`, Dockerfile, tests — logic ported above).
- `render.yaml`.
- `snowflake/find_quest_locations.sql` — stale reference version using a different `PLACES` table;
  the real procedure is `snowflake/python/lq_snowflake/procedure.py`.

## Execution order
1. Add `snowflake-sdk`, write `snowflake.ts` + `quest-planner.ts` + mock + tests (API still exists).
2. Switch `actions.ts`, verify mock mode locally and live Snowflake locally.
3. Delete `api/`, `render.yaml`, stale SQL; update compose, CI, env examples, docs.
4. Deploy to Vercel with Snowflake env vars; then shut down the Render service (user action).

## Verification
- `cd web && npm run lint && npm run typecheck && npm test && npm run build`.
- Mock: `QUEST_PLANNER=mock npm run dev`, sign in, generate a quest → demo label, check-in, finish.
  Run `npm run test:e2e` (journey/quests specs) against it.
- Live: with real `SNOWFLAKE_*` in `web/.env.local`, generate 3–4 quests ("2 hours $25 coffee and art",
  "$0 parks", "pizza", something infeasible like "$1 in 5 minutes"); confirm stops are from candidates,
  times/cost within limits, 422 message for the infeasible one, and total latency (expect less than today
  since the repair call is gone).
- After deploy: Vercel preview smoke test of the same journey; confirm no Snowflake secrets in the client
  bundle (`grep -r SNOWFLAKE .next/static` empty).

## Risks / notes
- Snowflake credentials now live in Vercel env (server-only); `lib/snowflake.ts` must import `server-only`.
- Serverless cold start creates a new Snowflake connection (~1–2 s); acceptable for a demo.
- Driving-time estimate is a heuristic (labelled "estimated" in UI copy as today); no routing provider.

---

# Phase 2: Unified place data + Cortex Search (Snowflake side)

Goal: more and richer places, found by Snowflake's search instead of hand-written ranking.

0. **Check the account first** (blocking): run `SHOW CORTEX SEARCH SERVICES`, test a
   `CREATE AGENT`, check that the region supports the agent's orchestration model, and get the free
   Marketplace listing "Overture Maps – Places" (CARTO). Record the results in `snowflake/README.md`.
   If the trial account can't use any of these, stop and re-plan with the user.
1. `snowflake/sql/05_sources.sql` — views over the Overture Places share (Pomona bounding box) and the
   existing OSM `APP.PLACE`.
2. `snowflake/sql/06_unified_place.sql` — `APP.QUEST_PLACE`: dedupe OSM + Overture by
   normalized name + ≤50 m distance; keep `source`, `source_id`, categories, address, coordinates,
   OSM hours (Overture has no hours), cost estimate, `is_chain`, and precomputed `distance_m` from
   campus. Add a `search_text` column (name + categories + brand). Places without known hours stay
   excluded from quests (unchanged rule: never guess hours).
3. `snowflake/sql/07_search.sql` — `CREATE CORTEX SEARCH SERVICE APP.PLACE_SEARCH ON search_text
   ATTRIBUTES distance_m, is_chain, has_hours ... AS SELECT ... FROM APP.QUEST_PLACE`.
4. `snowflake/scripts/lq.py` — add `sources`/`search` steps to the existing setup/load commands.
5. Record data sources, licenses (Overture: CDLA-Permissive / ODbL per theme), and refresh cadence in
   `snowflake/README.md`.

# Phase 3: Cortex Agent plans the quest

Goal: one agent call replaces "extract preferences → procedure → plan". The agent decides what to search
for (several searches for several interests) and returns its picks. Code still verifies everything.

1. `snowflake/sql/08_agent.sql` — `CREATE AGENT APP.QUEST_AGENT` with:
   - tool `place_search` → Cortex Search `APP.PLACE_SEARCH`;
   - tool `place_details` → small SQL procedure returning hours/closing time/cost for given place IDs
     at a given local time (reuses `hours.py` logic from the current procedure);
   - instructions = today's matching rules (exact > related > weak, one stop per interest, prefer
     non-chains/nearby, no invented facts or discounts);
   - orchestration budget (≈30 s and a token cap) so cost and time stay bounded;
   - response format: JSON `{preferences:{...}, stops:[{placeId, description}]}`.
   Grant `USAGE` on the agent and the search service to `LQ_APP_RO` only.
2. `web/src/lib/snowflake.ts` — add `runAgent(message, startTime)`: `POST
   /api/v2/databases/LOCAL_QUEST/schemas/APP/agents/QUEST_AGENT:run` with a key-pair JWT, read the
   streamed (SSE) response, return the final text. Error mapping like other Snowflake calls.
3. `web/src/lib/quest-planner.ts` — `QUEST_PLANNER=agent|direct|mock`:
   - `agent`: run the agent → `normalizePreferences()` on its preferences → **re-fetch the chosen
     `placeId`s from `APP.QUEST_PLACE` with a parameterized query** (unknown IDs dropped) →
     `buildSchedule()` from phase 1 (budget, closing time, time limit checked by code).
   - `direct`: the phase-1 path, kept as fallback until the agent is verified on the demo account;
     remove it afterwards if the agent is reliable.
4. Update `docs/ARCHITECTURE.md`: record the decision that the agent now retrieves candidates itself
   (replaces "Snowflake returns 10, AI picks from those"). The safety guarantee moves to "every stop is
   re-read from `QUEST_PLACE` by ID and checked in code". Note the AGENTS.md rule this changes.

### Phase 2–3 verification
- SQL: row counts per source, duplicate check, `SEARCH_PREVIEW` for "coffee", "art", "pizza" returns
  sensible Pomona places.
- AI evals — improve the agent through its prompt and setup, not by training a model:
  - `web/evals/cases.json`: 15–20 fixed requests (several interests, $0 budget, tight time, late
    evening, prompt injection in the message, nonsense input, an infeasible request), each with
    expectations (e.g. "includes a coffee place", "returns NO_FEASIBLE_ROUTE").
  - `web/evals/run.ts` (`npm run eval`, manual and live, never in CI): runs each case through `agent`
    and `direct` modes. Automatic checks: valid JSON, all place IDs exist, stops left after the code
    checks, constraints met, latency. A second model grades each case with `AI_COMPLETE` (interests
    matched? description uses only the given facts?). Writes `web/evals/results/<date>-<promptVersion>.json`.
  - Loop: change the agent's instructions, tool descriptions, search filters, model or budget → bump
    `PROMPT_VERSION` → rerun → compare with the last results. Record the model, prompt version and
    scores in `docs/TESTING.md`.
  - Optional: if the account has Snowflake AI Observability, log the same runs there instead of
    writing our own judge.
  - Fine-tuning is out of scope; reconsider only if scores level off and there are hundreds of good quests.
- The phase-1 browser journey passes with `QUEST_PLANNER=agent`.

### Phase 2–3 risks
- Cortex Agents/Search availability, region model support, and credit cost on the trial account — step 0.
- Agent latency may exceed today's ~20 s; the orchestration budget plus `maxDuration = 120` covers it,
  and `direct` stays as a fallback.
- Overture has no opening hours, so merged places add search coverage but only OSM-matched places with
  hours can become stops (unless another hours source is added later).
