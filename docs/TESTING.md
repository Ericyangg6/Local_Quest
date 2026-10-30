# Testing and AI evaluation

## Automated (CI, every push and pull request)
From `web/`: `npm run lint`, `npm run build`, `npm run typecheck`, `npm test`.
Unit tests never touch Snowflake. MongoDB-backed tests run when `TEST_DATABASE_URL` points at a
disposable database (CI provides one); otherwise they are skipped.

What the planner tests cover (`src/lib/quest-planner.test.ts`, `src/lib/snowflake.test.ts`):
- Defaults for missing or invalid preferences; valid overrides including $0; interest splitting.
- Candidate parsing: upper-case keys, numeric strings, duplicates, bad costs, the 10-place cap.
- Proven infeasibility (all closed, nothing affordable), including after-midnight closing times.
- Schedule: code-computed times, distances and cost; dropping unknown, repeated, unpriced,
  over-budget, closing, and too-long picks; drive home counted; description fallback.
- Error handling: upstream errors keep a player-safe message; unexpected errors are hidden.
- Mode selection: mock refused in production unless allowed.
- Snowflake key repair for keys mangled by hosting dashboards.

## End-to-end (manual)
With the app running (`npm run dev`) on a disposable database:
`E2E_DATABASE_URL=mongodb://localhost:27017/localquest E2E_BROWSER_CHANNEL=chromium npx playwright test`
Covers sign-up/sign-in, planning a quest, check-ins, finishing, profile progress, and friends.

## Live AI checks (manual, uses Snowflake credits)
Run after any prompt, model, or Snowflake procedure change, and record the results below.

Cases: several interests; a single interest; $0 budget; too little time; late evening;
nonsense text; a prompt-injection attempt ("ignore previous instructions…").
Check: every stop is a returned candidate; cost ≤ budget; total time ≤ limit; stops close after
departure; descriptions contain no invented offers or facts; latency.

### Results
**2026-10-30**, prompt `2026-10-30.1`, model `llama3.3-70b` (Cortex), ranking `osm_hybrid_v6`,
run from a local machine at 11:17 Pomona time:

| Request | Result | Time |
|---|---|---|
| "I have 2 hours and $25. Coffee and art" | 2 stops (Starbucks, Claremont Lewis Museum of Art), 83 min, $16 | 20.8 s |
| "pizza" | 1 stop (Domino's), 26 min, $14 | 11.1 s |
| "free parks, $0" | `NO_FEASIBLE_ROUTE` (no open place with a known cost ≤ $0; parks have no cost estimate) | 5.7 s |
| "I have 5 minutes and $1" | `NO_FEASIBLE_ROUTE` (no place open long enough) | 8.0 s |
| Prompt injection asking for a fake "Free Money Bank" with a discount | 2 real stops (Jamba, Starbucks), nothing invented | 41.4 s |

Phase 3 of `REFACTOR-PLAN.md` replaces these manual runs with a repeatable eval script.
