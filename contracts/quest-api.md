# Quest planner contract

The planner runs inside the Next.js server; there is no public HTTP route. Its entry point is
`planQuest(message)` in `web/src/lib/quest-planner.ts`, called only by the `generateQuest`
server action after the session check. Types: `web/src/lib/quest-types.ts` (the single source).

## Input
`message`: the player's free text, 1–2000 characters after trimming (checked by the action).

## Result
`{ ok: true, route, preferences }` or `{ ok: false, code, message, requestId, preferences? }`.

`preferences`: `{ desiredTime (minutes), desiredBudget (USD), locationPreference
("coffee, art" or "random"), travelMethod ("drive") }`; defaults 90 / 30 / "random".

`route` (`QuestRoute`, saved in MongoDB as is; unchanged from the old API so older quests load):

| Field | Meaning |
|---|---|
| `startLocation.address`, `endLocation.address` | Always `3801 W Temple Ave, Pomona, CA 91768` |
| `quests[]` | 1–10 stops in visiting order |
| `quests[].location` | `name`, `address`, `closingTime` ("HH:MM"), `estimatedCost` (USD category estimate) |
| `quests[].arrivalTime`, `departureTime` | Local "HH:MM", computed by code |
| `quests[].travelDistance` | Estimated road miles from the previous point |
| `quests[].task` | `{ id: "photo_inside" \| "photo_building" \| "review_screenshot", text }`, chosen at random by code |
| `quests[].description` | 1–2 sentences by the model, or template text |
| `totalTime` | Minutes including the drive home, ≤ `desiredTime` |
| `totalDistance` | Estimated road miles including the drive home |
| `estimatedCost` | Sum of stop costs, ≤ `desiredBudget` |
| `mock` | `true` only in mock mode; show a "Demo" label |

## Errors

| `code` | When | Player can |
|---|---|---|
| `NO_FEASIBLE_ROUTE` | Nothing open, nothing affordable, or no pick fits | Loosen time/budget (`preferences` shows what was understood) |
| `UPSTREAM_TIMEOUT` | Snowflake or Cortex took too long | Retry |
| `UPSTREAM_UNAVAILABLE` | Snowflake unreachable or refused the login | Retry later |
| `UPSTREAM_INVALID_RESPONSE` | Unreadable model reply or place list | Retry |
| `CONFIGURATION_ERROR` | Missing/invalid server settings | Nothing; fix configuration |
| `INTERNAL_ERROR` | Unexpected bug | Retry; report `requestId` |
