import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuestRoute } from "./quest-types";

// Start/check-in/finish rules against a real MongoDB. Skipped unless TEST_DATABASE_URL points at a
// disposable database, e.g. TEST_DATABASE_URL=mongodb://localhost:27017/localquest_unit npm test
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function stop(name: string): QuestRoute["quests"][number] {
  return {
    location: { name, address: `${name} St, Pomona, 91768`, closingTime: "21:00", estimatedCost: 5 },
    arrivalTime: "10:00",
    departureTime: "10:20",
    travelDistance: 0.5,
    task: { id: "photo_inside", text: "Take a picture of the inside" },
    description: `Visit ${name}.`,
  };
}

const route: QuestRoute = {
  startLocation: { address: "3801 W Temple Ave, Pomona, CA 91768" },
  quests: [stop("Cafe"), stop("Museum")],
  endLocation: { address: "3801 W Temple Ave, Pomona, CA 91768" },
  totalTime: 60,
  totalDistance: 1,
  estimatedCost: 10,
};

describe.skipIf(!testDatabaseUrl)("quest start, check-in, and finish", () => {
  let quests: typeof import("./quests");
  let dropDatabase: () => Promise<void>;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    quests = await import("./quests");
    const { getMongoClient } = await import("./db");
    const client = await getMongoClient();
    dropDatabase = async () => {
      await client.db().dropDatabase();
      await client.close();
    };
  });
  afterAll(async () => {
    await dropDatabase?.();
  });

  it("rejects check-ins until the quest is started", async () => {
    const userId = new ObjectId();
    const id = await quests.saveQuest(userId, "coffee", route);
    expect(await quests.checkInAtStop(userId, id, 0)).toBe(false);
    expect((await quests.getQuest(userId, id))?.checkIns).toEqual([null, null]);

    expect(await quests.startQuest(userId, id)).toBe(true);
    expect(await quests.checkInAtStop(userId, id, 0)).toBe(true);
    expect(await quests.checkInAtStop(userId, id, 0)).toBe(false); // repeat: no second stamp
  });

  it("finishes only after every stop is checked in, and only once", async () => {
    const userId = new ObjectId();
    const id = await quests.saveQuest(userId, "coffee", route);
    await quests.startQuest(userId, id);
    await quests.checkInAtStop(userId, id, 0);
    expect(await quests.finishQuest(userId, id)).toBe(false);
    expect((await quests.getQuest(userId, id))?.status).toBe("active");

    await quests.checkInAtStop(userId, id, 1);
    expect((await quests.getQuest(userId, id))?.status).toBe("active"); // no auto-finish
    expect(await quests.finishQuest(userId, id)).toBe(true);
    const finished = await quests.getQuest(userId, id);
    expect(finished?.status).toBe("done");

    expect(await quests.finishQuest(userId, id)).toBe(true);
    expect((await quests.getQuest(userId, id))?.completedAt).toEqual(finished?.completedAt);
    expect(await quests.checkInAtStop(userId, id, 0)).toBe(false); // finished quests take no stamps
  });

  it("does not let another player start, check in, or finish someone's quest", async () => {
    const owner = new ObjectId();
    const other = new ObjectId();
    const id = await quests.saveQuest(owner, "coffee", route);
    expect(await quests.startQuest(other, id)).toBe(false);
    expect((await quests.getQuest(owner, id))?.startedAt).toBeNull();

    await quests.startQuest(owner, id);
    expect(await quests.checkInAtStop(other, id, 0)).toBe(false);
    await quests.checkInAtStop(owner, id, 0);
    await quests.checkInAtStop(owner, id, 1);
    expect(await quests.finishQuest(other, id)).toBe(false);
    expect((await quests.getQuest(owner, id))?.status).toBe("active");
  });

  it("treats a quest saved before Start existed as started once it has a check-in", async () => {
    const userId = new ObjectId();
    const id = await quests.saveQuest(userId, "coffee", route);
    const collection = await quests.getQuestsCollection();
    await collection.updateOne({ _id: new ObjectId(id) }, { $set: { "checkIns.0": new Date() } });
    expect((await quests.getQuest(userId, id))?.startedAt).not.toBeNull();
    expect(await quests.checkInAtStop(userId, id, 1)).toBe(true);
  });
});
