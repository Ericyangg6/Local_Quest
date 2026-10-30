# Frontend: contributor guide

For teammates and their AI assistants. Scope: `web/`.

## Current state

- Stack: Next.js 16 (App Router, `src/app`) + React 19 + TypeScript, plain CSS with
  tokens in `src/styles/tokens.css`, `motion` for Figma-authored animation,
  self-hosted Jersey fonts via `@fontsource`.
- Auth: Auth.js v5 (`next-auth@5` beta) in `src/auth.ts` with Google and
  username/password (Credentials) providers, MongoDB via `@auth/mongodb-adapter`,
  JWT session cookies (30 days). Registration and sign-in are server actions in
  `src/features/auth/actions.ts`. Protected pages: `/quests` (signed-in home),
  `/profile`, and the reserved `/friends` prefix via `src/proxy.ts` plus a check in
  each page. Account schema: [data/ACCOUNTS.md](../data/ACCOUNTS.md).
- Commands (verified): `npm install`, `npm run dev` (port 3000), `npm run build`,
  `npm run typecheck`, `npm run lint`, `npm test` (unit), `npm run test:e2e`
  (needs a running app on a disposable database; see `playwright.config.ts`).
- Config: one project-wide `../.env` (template `../.env.example`), loaded by `next.config.ts`;
  never commit real values. Hosts set the same names in their environment settings.
- Screens: landing (`/`), register (`/register`), sign-in (`/sign-in`), Quests
  (`/quests`, protected, where users land after sign-in), and Profile (`/profile`,
  protected) from the LocalQuest Figma file (`dNPMN12L6f9V9tFchiIdeH`). The quest
  board has a "Plan my quest" form and lists the player's saved quests; `/quests/<id>` shows the route with simulated check-ins. The Explore page was removed;
  `/explore` redirects to `/quests` and the Explore tab is a disabled "coming soon" tab.
- Friends (`/friends`, protected): Figma "LocalQuest friends" frame. "+ Add friend" opens the
  Figma popup; requests are sent by exact username (optionally "@…") or exact name, with a
  pick list when several players share a name. Incoming requests (Accept/Decline) and sent
  requests (Cancel) are extra sections not in the design. Data: `src/lib/friends.ts`.
- Player cards (`/friends/<userId>`): every Friends-page row links to that player's card, rendered
  by the same `PlayerProfileView` as `/profile` in "friend" mode (no Edit profile, no quest links,
  no "Find your next quest"). Accepted friends see stats, badges, quest log, and friend count, plus
  "Remove friend". Others see a locked card with "+ Add friend", "Cancel request", or
  "Accept"/"Decline". Unknown ids get a 404; your own id redirects to `/profile`.
- Player settings (`/settings`, protected): profile picture upload/remove and Sign out.
  Opened from the header menu and the profile page's "Edit profile" link. No Figma frame
  exists for it; it reuses the sign-up banner and panel styles. Sign out also appears on
  `/sign-in` when already signed in.
- Profile picture: uploaded picture > Google photo > default pixel explorer
  (`src/lib/profile.ts`). Uploads happen on `/settings` via server actions (`src/features/profile/actions.ts`,
  ≤ 2 MB, PNG/JPEG/WebP detected from bytes) stored in MongoDB `avatars` and served by
  `src/app/api/avatars/[userId]/route.ts` to signed-in users. Quest stats, XP, badges,
  and the quest log show empty/zero states until quest progress is tracked.
- Don't run `npm run build` while `npm run dev` is running; the build rewrites `.next`
  and can crash the dev server.
- Header menu (`AppHeader/HeaderMenu.tsx`): Figma "Menu dropdown"; Player settings
  links to `/settings`, Support is "coming soon" until a support destination exists.
- Shared UI: `AppHeader`, `PixelButton`, `WideButton`/`WideLink`, `TextField`/`PasswordField`,
  `AuthBanner`, `BottomNav`, `PlayerAvatar`, `PixelSprite` (pixel art as run data in `sprites.ts`).
- Quest planning: `src/lib/quest-planner.ts` (preferences, candidates, schedule checks, prompts),
  `src/lib/snowflake.ts` (Snowflake SQL REST API with key-pair JWT; server only), mock fixtures in
  `src/lib/quest-planner.mock.ts`, shared types in `src/lib/quest-types.ts`. Called only by the
  `generateQuest` server action after the session check. `QUEST_PLANNER=mock|snowflake`.
  Saved quests and progress (XP, level, streak, badges): `src/lib/quests.ts`, `src/lib/progress.ts`.
  E2E journey: `e2e/journey.spec.ts` (mock or live planner).

## Boundaries

- Read the root [AGENTS.md](../AGENTS.md) and [architecture](../docs/ARCHITECTURE.md) first.
- Snowflake credentials and `snowflake.ts` stay server-only (it imports `server-only`); after a
  build, `grep -r SNOWFLAKE .next/static` must find nothing.
- The model only picks candidate IDs and writes descriptions; times, distances, costs, and
  checks stay in code. Keep `QuestRoute` backward compatible: saved quests are stored as is.
- Handle loading, nothing-fits, timeout, and unavailable states distinctly in the quest form.
- Verify narrow-screen and keyboard use for new screens.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
