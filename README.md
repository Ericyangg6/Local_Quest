# Local Quest

A personalized neighborhood adventure planner that connects exploration, playful
challenges, and discovery of local businesses.

Status (2026-10-30): one Next.js app that plans quests with Snowflake and saves them in
MongoDB. Verified locally with mock data and live Snowflake; not deployed yet.

## Documents
1. [Project brief](PROJECT.md): product, audience, scope, acceptance criteria.
2. [Agent instructions](AGENTS.md): rules for AI assistants working here.
3. [Architecture](docs/ARCHITECTURE.md): components, quest planning flow, decisions.
4. [Plan](REFACTOR-PLAN.md): current phase and next steps.
5. [Testing](docs/TESTING.md): automated checks and live AI results.
6. [Deployment](docs/Deployment.md): hosting, configuration, smoke checks, rollback, demo.
7. [Planner contract](contracts/quest-api.md), [account storage](data/ACCOUNTS.md),
   [frontend notes](web/AGENTS.md), [Snowflake](snowflake/README.md).

## How a quest is planned
Message → model extracts time/budget/interests (defaults 90 min, $30, any) → Snowflake returns
up to 10 open places near Cal Poly Pomona → model picks and orders stops → code computes drive
times and checks budget, closing times, and the time limit → quest saved and shown.

## Run locally
```bash
# 1. MongoDB (any local or hosted instance works)
docker run -d --name localquest-mongo -p 27017:27017 mongo:7   # or: brew services start mongodb-community

# 2. Config (once), one .env for everything: set AUTH_SECRET (npx auth secret) and
#    DATABASE_URL=mongodb://localhost:27017/localquest. QUEST_PLANNER=mock works offline;
#    for live quests set QUEST_PLANNER=snowflake and the SNOWFLAKE_* login.
cp .env.example .env

# 3. Web app on :3000
cd web && npm install && npm run dev
```
Open http://localhost:3000, register, plan a quest, check in at each stop, and see XP and badges
on the profile. Mock-mode quests are labeled "Demo".

Checks, from `web/`: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
End to end, with the app running:
`E2E_DATABASE_URL=mongodb://localhost:27017/localquest E2E_BROWSER_CHANNEL=chromium npx playwright test`
(run `npx playwright install chromium` once; the Google test also needs real Google credentials).

Snowflake setup and data loading (owner only): [snowflake/README.md](snowflake/README.md). It uses
the same `.env` (template [.env.example](.env.example)).

## Deploy
Vercel + MongoDB Atlas: [docs/Deployment.md](docs/Deployment.md).
CI (`.github/workflows/ci.yml`) runs lint, build, typecheck, and unit tests.

## License
The application code is released under the [MIT License](LICENSE)
(Copyright (c) 2026 Local Quest contributors).

Models, data, and dependencies keep their own licenses; the MIT License does not cover them:

| Component | Used for | License |
|---|---|---|
| Meta Llama 3.3 70B (`llama3.3-70b`, via Snowflake Cortex `AI_COMPLETE`) | Reading requests and choosing stops | [Llama 3.3 Community License](https://www.llama.com/llama3_3/license/) (open weights; includes an acceptable use policy) |
| Snowflake Arctic Embed M v1.5 (`snowflake-arctic-embed-m-v1.5`, via `AI_EMBED`) | Interest-to-category matching | Apache 2.0 |
| OpenStreetMap place and address data | Candidate places, geocoding | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/); show "© OpenStreetMap contributors" wherever the data appears |
| npm and Python dependencies | Web app and Snowflake scripts | Each package's own license (see `web/package-lock.json` and `snowflake/`) |

Snowflake Cortex is a hosted, proprietary service; running the AI steps requires a Snowflake account.
