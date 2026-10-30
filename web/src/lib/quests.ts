import "server-only";
import { ObjectId, type Collection } from "mongodb";
import { getMongoClient } from "./db";
import { summarizeProgress, type CheckIn, type PlayerProgress } from "./progress";
import type { QuestRoute } from "./quest-types";

/**
 * Saved quests, one document per generated route, owned by one user (`quests` collection).
 * Check-ins are simulated (a button press, no QR or merchant verification) and are never
 * evidence of a visit or purchase.
 */
export interface QuestDocument {
  _id: ObjectId;
  userId: ObjectId;
  /** The player's request text, as sent to the API. */
  request: string;
  /** The API's validated response, stored as returned. */
  route: QuestRoute;
  /** One entry per stop: when the player checked in, or null. Same length as route.quests. */
  checkIns: (Date | null)[];
  status: "active" | "done";
  /** True when the quest was planned in mock mode (QUEST_PLANNER=mock). */
  mock: boolean;
  createdAt: Date;
  /** Set when the player presses "Start quest"; check-ins are accepted only after this. */
  startedAt?: Date;
  completedAt?: Date;
}

/** What pages receive: string IDs, no user ID. */
export interface QuestView {
  id: string;
  request: string;
  route: QuestRoute;
  checkIns: (Date | null)[];
  status: "active" | "done";
  mock: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

let indexesReady: Promise<unknown> | undefined;

export async function getQuestsCollection(): Promise<Collection<QuestDocument>> {
  const client = await getMongoClient();
  const quests = client.db().collection<QuestDocument>("quests");
  indexesReady ??= quests
    .createIndex({ userId: 1, createdAt: -1 }, { name: "quest_user_created" })
    .catch((error) => {
      indexesReady = undefined;
      throw error;
    });
  await indexesReady;
  return quests;
}

function toView(doc: QuestDocument): QuestView {
  return {
    id: doc._id.toHexString(),
    request: doc.request,
    route: doc.route,
    checkIns: doc.checkIns,
    status: doc.status,
    mock: doc.mock,
    createdAt: doc.createdAt,
    // Quests saved before "Start quest" existed count as started once they have a check-in.
    startedAt: doc.startedAt ?? doc.checkIns.find((at): at is Date => at !== null) ?? null,
    completedAt: doc.completedAt ?? null,
  };
}

export async function saveQuest(userId: ObjectId, request: string, route: QuestRoute): Promise<string> {
  const quests = await getQuestsCollection();
  const _id = new ObjectId();
  await quests.insertOne({
    _id,
    userId,
    request,
    route,
    checkIns: route.quests.map(() => null),
    status: "active",
    mock: route.mock === true,
    createdAt: new Date(),
  });
  return _id.toHexString();
}

export async function listQuests(userId: ObjectId, limit = 50): Promise<QuestView[]> {
  const quests = await getQuestsCollection();
  const docs = await quests.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(toView);
}

/** Returns the quest only if this user owns it. */
export async function getQuest(userId: ObjectId, questId: string): Promise<QuestView | null> {
  if (!ObjectId.isValid(questId)) return null;
  const quests = await getQuestsCollection();
  const doc = await quests.findOne({ _id: new ObjectId(questId), userId });
  return doc ? toView(doc) : null;
}

/** Starts an active quest. Repeating it keeps the first start time. Returns false if it isn't this user's. */
export async function startQuest(userId: ObjectId, questId: string): Promise<boolean> {
  if (!ObjectId.isValid(questId)) return false;
  const quests = await getQuestsCollection();
  const _id = new ObjectId(questId);
  await quests.updateOne({ _id, userId, status: "active", startedAt: { $exists: false } }, { $set: { startedAt: new Date() } });
  return (await quests.countDocuments({ _id, userId })) === 1;
}

/**
 * Records a simulated check-in at one stop of a started, unfinished quest. Repeating it changes
 * nothing: the filter only matches while that stop has no check-in, so a stamp (and its XP) is
 * counted once. Returns false if the quest isn't this user's or the stop doesn't exist.
 */
export async function checkInAtStop(userId: ObjectId, questId: string, stopIndex: number): Promise<boolean> {
  if (!ObjectId.isValid(questId) || !Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex > 9) return false;
  const quests = await getQuestsCollection();
  const _id = new ObjectId(questId);
  const doc = await quests.findOne({ _id, userId }, { projection: { checkIns: 1 } });
  if (!doc || stopIndex >= doc.checkIns.length) return false;

  // Started = pressed "Start quest", or (for quests saved before that button) has a check-in.
  const started = { $or: [{ startedAt: { $exists: true } }, { checkIns: { $elemMatch: { $ne: null } } }] };
  const result = await quests.updateOne(
    { _id, userId, status: "active", [`checkIns.${stopIndex}`]: null, ...started },
    { $set: { [`checkIns.${stopIndex}`]: new Date() } },
  );
  return result.modifiedCount === 1;
}

/**
 * Finishes a quest once every stop has a check-in. Idempotent: an already-finished quest keeps
 * its completion time. Returns true when the quest is (now) done.
 */
export async function finishQuest(userId: ObjectId, questId: string): Promise<boolean> {
  if (!ObjectId.isValid(questId)) return false;
  const quests = await getQuestsCollection();
  const _id = new ObjectId(questId);
  await quests.updateOne(
    { _id, userId, status: "active", checkIns: { $ne: null } }, // on an array: no element is null
    { $set: { status: "done", completedAt: new Date() } },
  );
  return (await quests.countDocuments({ _id, userId, status: "done" })) === 1;
}

/** Removes a quest the player no longer wants. Only the owner can delete it. */
export async function deleteQuest(userId: ObjectId, questId: string): Promise<void> {
  if (!ObjectId.isValid(questId)) return;
  const quests = await getQuestsCollection();
  await quests.deleteOne({ _id: new ObjectId(questId), userId });
}

export async function getPlayerProgress(userId: ObjectId, now = new Date()): Promise<PlayerProgress> {
  const quests = await getQuestsCollection();
  const docs = await quests
    .find({ userId }, { projection: { route: 1, checkIns: 1, status: 1, completedAt: 1 } })
    .toArray();
  const checkIns: CheckIn[] = [];
  let questsDone = 0;
  for (const doc of docs) {
    if (doc.status === "done") questsDone += 1;
    doc.checkIns.forEach((at, i) => {
      const stop = doc.route.quests[i];
      if (at && stop) checkIns.push({ at, placeKey: `${stop.location.name}|${stop.location.address}`.toLowerCase() });
    });
  }
  return summarizeProgress({ questsDone, checkIns }, now);
}
