# Local Quest: agent instructions

Applies to this folder. Paths below are relative to it. General working rules (honest
configuration, verification, security, completion reports) are in the parent folder's
`AGENTS.md`; this file adds what is specific to Local Quest.

## Read before working
- `PROJECT.md`: product requirements.
- `docs/ARCHITECTURE.md`: the system, its components, and recorded decisions. Read before
  structural or interface changes and update it when a decision changes.
- `REFACTOR-PLAN.md`: the current plan and phase.
- `docs/TESTING.md`: what is tested and how AI behavior is evaluated.
- `docs/Deployment.md`: before deployment or any Snowflake change.
- `web/AGENTS.md` and `snowflake/README.md` for work in those folders.

## Shape of the system
One Next.js app (`web/`) serves the pages, signs players in, plans quests on the server,
and stores accounts and quests in MongoDB. Snowflake (`snowflake/`) holds the place catalog,
the candidate search procedure, and the Cortex model. There is no separate backend service;
do not add one without an architecture decision.

## Quest planning rules
- Normalize omitted or invalid model-extracted inputs to 90 minutes, $30, and no
  preference. Keep valid overrides, including a $0 budget.
- Snowflake returns up to 10 candidates; the model only picks and orders candidate IDs
  and writes descriptions. Code computes times, distances, and cost, and checks budget,
  closing times, and the time limit before a quest is saved. Never trust model totals.
- Ground descriptions in catalog facts; never invent discounts, offers, or partnerships.
- Keep simulated check-ins distinct from real merchant redemptions.
- Label mock mode (`QUEST_PLANNER=mock`) visibly; never describe it as live.

## Secrets and data
- Snowflake keys and other secrets live only in server environment settings or local
  ignored files (`.env`, `web/.env.local`). Never in source, logs, fixtures, or the browser.
- The app uses the least-privilege Snowflake role `LQ_APP_RO`; the owner role `LQ_OWNER`
  is only for `snowflake/scripts/lq.py`.
- Snowflake schema changes go through versioned files in `snowflake/sql/`.

## Checks
From `web/`: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
After prompt or model changes, run the live AI evaluation described in `docs/TESTING.md`
and record the model, prompt version, and results there.
