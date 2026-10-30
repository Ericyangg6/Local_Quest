import { hash } from "@node-rs/argon2";
import { expect, test, type Page } from "@playwright/test";
import { MongoClient, ObjectId } from "mongodb";

// Full journey: web (Auth.js + MongoDB) → Next.js server action → quest planner → Snowflake.
// With QUEST_PLANNER=mock (the default in development) the route uses the demo fixtures;
// with QUEST_PLANNER=snowflake it is a real Pomona route.
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error("Set E2E_DATABASE_URL to the disposable database the app under test uses.");

const run = Date.now().toString(36);
const PASSWORD = "walking2coffee";

let mongo: MongoClient;
test.beforeAll(async () => {
  mongo = await new MongoClient(databaseUrl).connect();
});
test.afterAll(async () => {
  await mongo?.close();
});

async function createPlayer(name: string, username: string) {
  await mongo.db().collection("users").insertOne({
    name,
    username,
    email: `${username}@example.com`,
    emailVerified: null,
    passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    createdAt: new Date(),
  });
}

async function signIn(page: Page, username: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/quests$/);
}

test.describe.configure({ mode: "serial" });

test("plan a quest, check in at every stop, and see progress on the profile", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const username = `journey_${run}`;
  await createPlayer("Riley Chen", username);
  await signIn(page, username);

  await page.getByLabel("What are you in the mood for?").fill("2 hours and $25. Coffee and art, walking");
  await page.getByRole("button", { name: "Plan my quest" }).click();
  await expect(page).toHaveURL(/\/quests\/[0-9a-f]{24}$/, { timeout: 100_000 });
  const questUrl = page.url();

  await expect(page.getByRole("heading", { name: "Your quest" })).toBeVisible();
  await expect(page.getByText("3801 W Temple Ave, Pomona, CA 91768").first()).toBeVisible();
  // Not started yet: no check-ins and no finish until the player presses Start.
  await expect(page.getByRole("button", { name: "Check in (simulated)" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finish quest" })).toHaveCount(0);
  const stopCount = await page.getByText("Start the quest to check in").count();
  expect(stopCount).toBeGreaterThan(0);

  // The saved quest belongs to this player and starts with no check-ins.
  const questId = questUrl.split("/").pop()!;
  const saved = await mongo.db().collection("quests").findOne({ _id: new ObjectId(questId) });
  expect(saved?.checkIns).toHaveLength(stopCount);
  expect(saved?.status).toBe("active");
  expect(saved?.startedAt).toBeUndefined();

  // Another player gets a 404 for this quest.
  const otherName = `other_${run}`;
  await createPlayer("Sam Ortiz", otherName);
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await signIn(otherPage, otherName);
  const response = await otherPage.goto(questUrl);
  expect(response?.status()).toBe(404);
  await otherContext.close();

  // Board lists it as in progress.
  await page.goto("/quests");
  await expect(page.getByRole("button", { name: "In progress (1)" })).toBeVisible();
  await expect(page.getByText("Not started")).toBeVisible();

  // Start, then check in at every stop. Finish stays locked until the last stamp.
  await page.goto(questUrl);
  await page.getByRole("button", { name: "Start quest" }).click();
  await expect(page.getByRole("heading", { name: "Quest in progress" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check in (simulated)" })).toHaveCount(stopCount);
  await expect(page.getByRole("button", { name: "Finish quest" })).toBeDisabled();
  for (let i = 0; i < stopCount; i++) {
    await page.getByRole("button", { name: "Check in (simulated)" }).first().click();
    await expect(page.getByText(`${i + 1} of ${stopCount} stops checked in`)).toBeVisible();
  }
  await expect(page.getByText("Stamped", { exact: true })).toHaveCount(stopCount);
  expect((await mongo.db().collection("quests").findOne({ _id: new ObjectId(questId) }))?.status).toBe("active");
  await page.getByRole("button", { name: "Finish quest" }).click();
  await expect(page.getByRole("heading", { name: "Quest complete!" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish quest" })).toHaveCount(0);

  // Board and profile reflect the completed quest.
  const xp = stopCount * 10 + 50;
  await page.goto("/quests");
  await expect(page.getByRole("button", { name: "Done (1)" })).toBeVisible();
  await expect(page.getByText(`${xp} XP`)).toBeVisible();
  await expect(page.getByText("1-day streak. Keep it going, Riley!")).toBeVisible();

  await page.goto("/profile");
  await expect(page.getByText(`${xp} XP`)).toBeVisible();
  await expect(page.getByText("First steps").locator("..")).toContainText("(unlocked)");
  await expect(page.getByRole("heading", { name: "Quest log" })).toBeVisible();
  await expect(page.locator(".profile-log__item")).toHaveCount(1);
});

test("an empty request is rejected before calling the planner", async ({ page }) => {
  const username = `empty_${run}`;
  await createPlayer("Ana Ruiz", username);
  await signIn(page, username);
  // Spaces pass the browser's `required` check but fail server-side trimming.
  await page.getByLabel("What are you in the mood for?").fill("   ");
  await page.getByRole("button", { name: "Plan my quest" }).click();
  await expect(page.locator(".new-quest__error")).toContainText("Tell us what kind of adventure you want.");
});
