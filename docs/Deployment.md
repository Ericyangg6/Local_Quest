# Deployment

Status (2026-10-30): the merged app (Next.js + Snowflake, no separate API) is verified locally
in mock and live Snowflake modes. **Not deployed yet.** Target: Vercel (web) + MongoDB Atlas.
Steps marked *unverified* have not been run in this form.

## What gets deployed

| Piece | Runs as | Needs |
|---|---|---|
| Web app (`web/`, Next.js) | Vercel project (root `web`) | MongoDB, Snowflake key-pair login, Google OAuth client |
| MongoDB | MongoDB Atlas (free M0) | persistent storage |
| Snowflake procedure + Cortex model | already deployed in account `LHXLXHN-WY63275` | redeploy only after `snowflake/python` changes (`snowflake/scripts/lq.py deploy`) |

Snowflake is called only from the Next.js server, after the session check, with the
least-privilege role `LQ_APP_RO` (it can only run the procedure and Cortex).

## Configuration (names only; values go in the host's secret settings)
Template: `.env.example` (locally everything goes in `local-quest/.env`).
- `AUTH_SECRET` (new per environment, `npx auth secret`), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
  `DATABASE_URL`.
- `QUEST_PLANNER=snowflake`, `QUEST_TIMEZONE=America/Los_Angeles`.
- `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PRIVATE_KEY` (the whole .p8 text; any line
  format works) or `SNOWFLAKE_PRIVATE_KEY_PATH` (a mounted file), `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`
  if encrypted, `SNOWFLAKE_ROLE=LQ_APP_RO`, `SNOWFLAKE_WAREHOUSE=LQ_WH`,
  `SNOWFLAKE_DATABASE=LOCAL_QUEST`, `SNOWFLAKE_SCHEMA=APP`, `SNOWFLAKE_AI_MODEL=llama3.3-70b`,
  `SNOWFLAKE_QUERY_TIMEOUT_S=40`.
- Only if hosting somewhere other than Vercel: `AUTH_TRUST_HOST=true`, and `TRUST_PROXY=true` behind a proxy.

Google Cloud Console: add `https://<your-domain>/api/auth/callback/google` to the OAuth
client's authorized redirect URIs.

## Vercel + MongoDB Atlas (selected; unverified)

1. **Snowflake login for the web app** (never put the owner's key on a host). If the
   `LQ_API_RENDER` service user from the old Render setup exists, reuse it. Otherwise, on your Mac:
   `openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out ~/.snowflake/keys/lq_web.p8` and
   `openssl rsa -in ~/.snowflake/keys/lq_web.p8 -pubout`. In a Snowflake worksheet:
   `USE ROLE SECURITYADMIN; CREATE USER IF NOT EXISTS LQ_WEB TYPE = SERVICE DEFAULT_ROLE = LQ_APP_RO DEFAULT_WAREHOUSE = LQ_WH;`
   `ALTER USER LQ_WEB SET RSA_PUBLIC_KEY = '<public key body, no BEGIN/END lines>';`
   `GRANT ROLE LQ_APP_RO TO USER LQ_WEB;` (revoke with `DROP USER LQ_WEB;`).
2. **MongoDB Atlas:** free M0 cluster, a database user, Network Access `0.0.0.0/0` (Vercel has no
   fixed IPs on Hobby). Connection string with the database name:
   `mongodb+srv://USER:PASS@CLUSTER/localquest?retryWrites=true&w=majority` → `DATABASE_URL`.
3. **Vercel:** Add New → Project → import the repo, **Root Directory** `web`. Set the
   configuration above for Production (paste the .p8 text into `SNOWFLAKE_PRIVATE_KEY`,
   `TRUST_PROXY=true`, no `AUTH_TRUST_HOST`). Deploy.
4. **Google OAuth:** add `https://<project>.vercel.app/api/auth/callback/google`.
5. Run the smoke check below.
6. If the old Render API service exists, delete it in the Render dashboard; it is no longer used.

Planning takes ~10–40 s; `web/src/app/quests/page.tsx` sets `maxDuration = 120` (Vercel Hobby
allows up to 300 s). Vercel deploys every push to `main` and makes a preview for every branch.

Record the URLs and who can deploy: Vercel project [TO FILL], Atlas cluster [TO FILL].

## Before every deploy
1. CI is green (`.github/workflows/ci.yml`). Make it required with branch protection on `main`;
   the workflow file alone doesn't enforce it.
2. No data migration: MongoDB collections and indexes are created on first use; quests saved by
   the old API keep the same shape.
3. Note the commit, the Snowflake `ranking_version` (`osm_hybrid_v6`), and the prompt version
   (`PROMPT_VERSION` in `web/src/lib/quest-planner.ts`).

## Smoke check (after every deploy)
1. `https://<domain>/` loads.
2. Register (or sign in with Google), plan "I want food and coffee": a live (not "Demo") route
   from Cal Poly Pomona appears within ~40 s.
3. Start the quest, check in at every stop, finish; XP and the quest log update on Profile.
4. "$0, 5 minutes" returns the "nothing fits" explanation, not a fake route.
Record the date, URL, commit, and results under **Result**.

## Rollback
- **Vercel:** Deployments → last good production deployment → Instant Rollback.
- **Snowflake ranking:** check out the previous `snowflake/python/lq_snowflake` and run
  `snowflake/.venv/bin/python snowflake/scripts/lq.py deploy` (code only).
- Re-run the smoke check after any rollback.

## Costs and limits
Snowflake: warehouse `LQ_WH` (XS, 60 s auto-suspend, 10-credit resource monitor) plus two Cortex
`AI_COMPLETE` calls per quest (and `AI_EMBED` inside the procedure for some interests). Each
player can plan 10 quests per 10 minutes; limits are in memory per instance (best effort).

## Result
Record who deployed, when, the commit, the URL, and which checks passed. Do not describe a
planned step as verified. [TO FILL]

## Demo and submission

### Short demonstration
1. The problem: finding an affordable, interesting short outing takes effort.
2. Type a request ("2 hours, $25, coffee and art"); show what the planner understood.
3. Show Snowflake returning up to 10 open candidates, the model picking and ordering stops, and
   code checking time, budget, and closing times.
4. Change a constraint and show a new route or an honest "nothing fits".
5. Check in at each stop (simulated), finish, and show XP and badges.
6. Name the Snowflake features and the open-weight model used.

### Evidence for prize entries
- Show a real Snowflake query and the app behavior it drives.
- Show the AI's role, model identity and license, and the evaluation results in `docs/TESTING.md`.
- Publish the source with its license and reproducible setup.
- Label simulated check-ins and estimated costs; do not imply merchant partnerships.

### Backup
Record a truthful demo video once the live journey works. If live services fail, use and label
mock mode instead of presenting it as live.
