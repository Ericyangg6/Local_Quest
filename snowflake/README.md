# Snowflake: top places near the user (Pomona test)

The web app's quest planner (`web/src/lib/quest-planner.ts`) makes exactly this call:

```sql
CALL LOCAL_QUEST.APP.FIND_QUEST_LOCATIONS(
  PARSE_JSON('{"desiredTime":120,"desiredBudget":25.0,"locationPreference":"coffee, art","travelMethod":"walk"}'),
  '3801 W Temple Ave, Pomona, CA 91768');
```

Snowflake returns `{"locations": [...]}` with **10** Pomona-area businesses that are
**open from now until `desiredTime` minutes from now**. They are ranked by how well
they match the preferences and how close they are. The planner reads this directly
(`QUEST_PLANNER=snowflake`); verified end to end on 2026-10-30 (`docs/TESTING.md`).

**Status (2026-10-23):** deployed to database `LOCAL_QUEST` on account
`LHXLXHN-WY63275` (AWS_US_EAST_2).
- **Loaded:** 97 OpenStreetMap businesses (94 with readable hours) and 1,220 OSM street addresses.
- **Verified as `LQ_APP_RO`:** the exact call above (walk and drive), plus unknown address, malformed address, and negative budget.
- **Removed:** the earlier `LOCAL_QUEST_DEV` database.
- **Stale:** an earlier account (`YVRSKSP-BQ40898`) still holds an older version.

## Dataset
The only dataset is **OpenStreetMap**, fetched from the Overpass API. It covers
named businesses with an `opening_hours` tag inside Pomona's bounding box
`34.01,-117.83,34.10,-117.71`, which includes Cal Poly Pomona. License: ODbL-1.0.
Show "© OpenStreetMap contributors" wherever the data appears.

**Costs:** OSM has no prices, but the planner needs a cost per stop to enforce the budget.
Each place therefore gets a **category estimate** from `APP.CATEGORY_COST`, the
highest typical spend among its tags (e.g. cafe $6, pizza $14, museum $10, library
$0). It is returned as `estimatedCost`, with `costBasis` stating that it is a
category estimate, not the place's price. Categories with no sensible visit spend
(car repair, storage, banks, phone shops) have no estimate, so `estimatedCost` is
null and the planner won't use them as stops. The table can be edited with `MERGE`.

**Chains:** each `PLACE` row has `is_chain` and `chain_reason`, set during the load
(`sql/04_load.sql`). A place counts as a chain if it has an OSM `brand` or `brand:wikidata`
tag (`brand_tag`), if its name matches another place's brand (`brand_name`), or if the same
name appears at more than one place (`repeated_name`). Names are compared in lowercase with
punctuation and spaces removed. This is a label only: `FIND_QUEST_LOCATIONS` doesn't filter on it yet.
On the 2026-10-23 Pomona extract, 51 of 97 places have a brand tag. Most are food, such as
McDonald's, Subway and Starbucks. Art, parks and the library are local. To apply it to the deployed
account, run `lq.py setup` (adds the columns) and then `lq.py load` (re-fetches and flags).

**Addresses:** the same OSM extract supplies street addresses (house number + street)
to geocode the request's address inside Snowflake. This trial account blocks all
outside network access ("External access is not supported for trial accounts"), so
an online geocoder can't be used. OSM has only about 1,200 addressed places in
Pomona: most businesses and the Cal Poly campus are covered, but most home
addresses are not.

## Layout
| Path | Purpose |
|---|---|
| `sql/01_setup.sql` | Roles `LQ_OWNER`/`LQ_APP_RO`, warehouse `LQ_WH` (XS, 60 s suspend, 10-credit monitor), database, schema `APP` |
| `sql/02_tables.sql` | `PLACE`, `PLACE_HOURS`, `ADDRESS`, `INTEREST_SYNONYM` and `CATEGORY_COST` (seeded), `CATEGORY_EMBEDDING`, stages |
| `sql/03_functions.sql` | `PARSE_OSM_HOURS` UDF, `FIND_QUEST_LOCATIONS(VARIANT, STRING)` procedure, grant to `LQ_APP_RO` |
| `sql/04_load.sql` | Replace places and addresses from the uploaded NDJSON, parse hours, embed new categories |
| `python/lq_snowflake/` | Procedure code: `request` (request parsing), `addresses` (normalization), `hours`, `ranking`, `procedure`, `osm_hours` (parser), `settings` |
| `scripts/lq.py` | Runner: `check`, `setup [--reset]`, `deploy`, `load`, `call` |
| `scripts/osm_fetch.py` | Pomona OSM download (used by `load`) |

## Run
One-time local setup: create `snowflake/.venv` with `snowflake-connector-python`.
Configuration lives in `local-quest/.env` (template: `local-quest/.env.example`), the same file
the web app uses. It is gitignored, and the key file stays
outside the repo.

```sh
PY=snowflake/.venv/bin/python; LQ=snowflake/scripts/lq.py
$PY $LQ check              # connection works
$PY $LQ setup              # add --reset to drop and rebuild the database
$PY $LQ deploy             # after any Python change
$PY $LQ load               # refresh Pomona places + addresses from OSM
$PY $LQ call test.json "3801 W Temple Ave, Pomona, CA 91768"   # --out FILE, --role LQ_APP_RO
```

## Request
Two arguments: the JSON and the address.

| Field | Meaning |
|---|---|
| `desiredTime` | Minutes available, from 1 to 1440 |
| `desiredBudget` | Dollars, at least 0. Echoed; the planner checks it against `estimatedCost` |
| `locationPreference` | Comma-separated preferences, up to 5. May be empty |
| `travelMethod` | `walk`, `bike`, `transit`, or `drive` sets the search radius; anything else searches as walk |
| address | `"<number> <street>, <city>, <state> <zip>"`, looked up in the OSM addresses |

A bad input fails with `LQ_INVALID_INPUT: <field>: <reason>`. Examples:
- `address: not found in the Pomona address data`
- `desiredBudget: must be a non-negative number of dollars`

## Response
The top level is `{request_id, retrieved_at, ranking_version, constraints, location_count, locations[]}`.

`constraints` shows how Snowflake read the request:
- `address` and `matched_address`
- `start` coordinates
- `departure_time` (now) and `timezone`
- `available_seconds`
- `budget` in cents
- `interests`
- `travel_method` and `radius_travel_method`

Each location has these fields:
- **Shown to players:** `name`, `address`, `closingTime` ("HH:MM" local; after midnight means late night), `estimatedCost`
- **Used by the planner:** `coordinates` and `distance_m` (drive-time estimates); `tags`, `match_reasons`, `rank`, `within_radius` (shown to the model only)
- **Ignored:** `place_id`, `costBasis`, `website`, `opening_intervals`, `hours_as_of`, `source_url`, `attribution`

When OSM has no street address, `address` is the coordinates, e.g. `"34.057978, -117.749360"`.

## How results are chosen
1. Geocode the address. Match the house number, normalized street ("W Temple Ave" = "West Temple Avenue"), and ZIP against `APP.ADDRESS`. When several OSM features share the address, use their median point.
2. Businesses within the travel radius, `min(cap, speed × desiredTime × 60 / 2)` straight-line distance:

   | Method | Speed | Cap |
   |---|---|---|
   | walk | 1.3 m/s | 2 km |
   | bike | 4 m/s | 6 km |
   | transit | 6 m/s | 8 km |
   | drive | 11 m/s | 15 km |
3. Keep only those open for at least 20 continuous minutes between now (Pomona time) and now + `desiredTime`. Unknown hours are excluded, never guessed.
4. Preference match is the best tag score across the preferences:
   - **Keyword:** 1.0 for an exact tag, the weight in `APP.INTEREST_SYNONYM` for a synonym (e.g. coffee → cafe 0.9), or 0.8 when the interest is a word in the tag.
   - **Drink-only places are not "food":** OSM tags juice bars and boba shops as fast food. For food interests (`food`, `restaurant`, `meal`, …), a place whose only cuisine tags are drinks (juice, bubble tea, tea, coffee shop) keeps 0.4 × its match, so it gets no "food" reason (since `osm_hybrid_v6`, 2026-10-23). It still matches `coffee` or `boba`.
   - **Cortex fallback:** used only for interests with no keyword match nearby. `AI_EMBED` finds the single closest category (e.g. "cozy study spot" → cafe), which scores 0.85 if its cosine is at least 0.8. Only the top 1 is used because ranks 2–5 were noise on this data.
5. Score = 0.7 × match + 0.3 × closeness. Ties go to the shorter distance, then `place_id`.
6. The procedure aims for 10. If fewer than 10 open places are inside the radius, the rest are filled from farther open places, up to 25 km, ranked by score then distance. These are marked `within_radius: false` with a match reason saying so. Nothing is invented; the planner's schedule check still enforces the time limit.

Settings live in `python/lq_snowflake/settings.py`. Change `RANKING_VERSION`
whenever a setting changes. The synonym table can be edited with `MERGE` without
redeploying.

## Notes
- **Login:** key-pair login uses the *login name* (`ERICY` here; it was the email on the earlier account).
- **Cortex on trials:** some trial accounts block Cortex AI functions entirely. This account allows them.
- **Data gap:** many Cal Poly campus businesses (Saddles Cafe, the library Starbucks, Element Coffee, Lollicup, Panda Express and others) are in OSM without `opening_hours`. The hours rule excludes them, so a campus walk start finds only about 4 open places within 2 km and fills the rest from farther away.
- **Fewer than 10 open places:** late at night the whole dataset may have fewer than 10 open places. Snowflake then returns fewer, and the planner works with those (none → "nothing fits").

## Design decisions (2026-10-23)
- **Scope:** one dataset, OpenStreetMap, covering Pomona only.
- **Removed:** the earlier multi-source design (Overture Marketplace matching, a
  curated overlay, multi-region ingest, an H3 prefilter, analytics views).
- **Hours are required:** a place is returned only if its OSM `opening_hours`
  parse and show it open for at least 20 minutes during the user's window.
  Unsupported syntax (holidays, sunrise, comments) means unknown, so the place
  is excluded.
- **Matching:** keyword/synonym first. Cortex `AI_EMBED` is a fallback that uses
  only the top-1 closest category per interest. Measured on this data, the
  closest category was right for every probe, and ranks 2–5 were noise.
- **Interface:** the web app calls `LOCAL_QUEST.APP.FIND_QUEST_LOCATIONS(PARSE_JSON(?), ?)` as role
  `LQ_APP_RO`, which can run only that procedure. Request values are bound, never
  concatenated into SQL.
- **Budget:** validated but not used for filtering, because OSM has no prices.

- **Call (2026-10-23):** the caller passes
  `LOCAL_QUEST.APP.FIND_QUEST_LOCATIONS(PARSE_JSON(<json>), <address>)` with
  `desiredTime` (minutes), `desiredBudget` (dollars), `locationPreference`
  (comma-separated), and `travelMethod` (always "drive" since 2026-10-23). The window starts
  now, Pomona time.
- **Geocoding** uses OSM addresses loaded into Snowflake. The trial blocks
  external access, so Census and Nominatim can't be called.

### Open
- Campus businesses often lack OSM hours, so near Cal Poly only about 4 places qualify.
  Options: add hours by hand, relax the hours rule, or add a source with hours.
- About 95 places is small. Widening the bounding box or adding a second source
  is a later decision.
- Event delivery and analytics were removed. Revisit them if the dashboard needs
  Snowflake.

Phase 2 of `REFACTOR-PLAN.md` revisits the single-source decision (Overture Marketplace data + Cortex Search).
