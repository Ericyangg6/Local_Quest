import "server-only";
import { ObjectId, type Collection } from "mongodb";
import { getMongoClient, getUsersCollection } from "./db";

/** One document per pair of players. Declining or cancelling deletes it. */
export interface FriendshipDocument {
  _id: ObjectId;
  requesterId: ObjectId;
  recipientId: ObjectId;
  /** Both ids, sorted and joined; unique, so a pair can only have one friendship. */
  pairKey: string;
  status: "pending" | "accepted";
  createdAt: Date;
  acceptedAt?: Date;
}

/** Fields of another player that are safe to show. */
export interface PlayerSummary {
  id: string;
  name: string;
  username: string | null;
}

export interface FriendsOverview {
  friends: PlayerSummary[];
  incoming: (PlayerSummary & { requestId: string })[];
  outgoing: (PlayerSummary & { requestId: string })[];
}

export function pairKey(a: ObjectId, b: ObjectId) {
  return [a.toHexString(), b.toHexString()].sort().join(":");
}

let indexes: Promise<unknown> | undefined;

export async function getFriendshipsCollection(): Promise<Collection<FriendshipDocument>> {
  const collection = (await getMongoClient()).db().collection<FriendshipDocument>("friendships");
  // Created here rather than at connect time so an already-running server picks them up.
  indexes ??= Promise.all([
    collection.createIndex({ pairKey: 1 }, { unique: true, name: "pair_unique" }),
    collection.createIndex({ recipientId: 1, status: 1 }, { name: "recipient_status" }),
    collection.createIndex({ requesterId: 1, status: 1 }, { name: "requester_status" }),
  ]).catch((error) => {
    indexes = undefined;
    throw error;
  });
  await indexes;
  return collection;
}

const SUMMARY_PROJECTION = { name: 1, username: 1 } as const;

function toSummary(user: { _id: ObjectId; name?: string | null; username?: string }): PlayerSummary {
  return { id: user._id.toHexString(), name: user.name || user.username || "Explorer", username: user.username ?? null };
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds players by exact username (with or without "@") or exact name, ignoring case.
 * Exact matching only, so the box can't be used to browse every player.
 */
export async function findPlayers(query: string, excludeId: ObjectId, limit = 6): Promise<PlayerSummary[]> {
  const trimmed = query.trim();
  const usernameOnly = trimmed.startsWith("@");
  const text = (usernameOnly ? trimmed.slice(1) : trimmed).replace(/\s+/g, " ");
  if (!text) return [];

  const conditions: object[] = [{ username: text.toLowerCase() }];
  if (!usernameOnly) conditions.push({ name: { $regex: `^${escapeRegex(text)}$`, $options: "i" } });

  const users = await getUsersCollection();
  const matches = await users
    .find({ $or: conditions, _id: { $ne: excludeId } }, { projection: SUMMARY_PROJECTION, limit })
    .toArray();
  return matches.map(toSummary);
}

export async function getPlayerSummary(id: ObjectId): Promise<PlayerSummary | null> {
  const user = await (await getUsersCollection()).findOne({ _id: id }, { projection: SUMMARY_PROJECTION });
  return user ? toSummary(user) : null;
}

/** Accepted friends plus pending requests in both directions for one player. */
export async function getFriendsOverview(userId: ObjectId): Promise<FriendsOverview> {
  const friendships = await getFriendshipsCollection();
  const docs = await friendships
    .find({ $or: [{ requesterId: userId }, { recipientId: userId }] })
    .sort({ acceptedAt: -1, createdAt: -1 })
    .toArray();

  const otherId = (doc: FriendshipDocument) => (doc.requesterId.equals(userId) ? doc.recipientId : doc.requesterId);
  const users = await getUsersCollection();
  const people = await users
    .find({ _id: { $in: docs.map(otherId) } }, { projection: SUMMARY_PROJECTION })
    .toArray();
  const byId = new Map(people.map((person) => [person._id.toHexString(), toSummary(person)]));

  const overview: FriendsOverview = { friends: [], incoming: [], outgoing: [] };
  for (const doc of docs) {
    const person = byId.get(otherId(doc).toHexString());
    if (!person) continue; // the other account was deleted
    if (doc.status === "accepted") overview.friends.push(person);
    else if (doc.recipientId.equals(userId)) overview.incoming.push({ ...person, requestId: doc._id.toHexString() });
    else overview.outgoing.push({ ...person, requestId: doc._id.toHexString() });
  }
  overview.friends.sort((a, b) => a.name.localeCompare(b.name));
  return overview;
}

export function initials(name: string) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]);
  return (letters.length > 1 ? letters[0] + letters[letters.length - 1] : name.slice(0, 2)).toUpperCase();
}

export type Relationship =
  | { kind: "self" }
  | { kind: "none" }
  | { kind: "friends" }
  /** You sent them a request. */
  | { kind: "outgoing"; requestId: string }
  /** They sent you a request. */
  | { kind: "incoming"; requestId: string };

/** How `viewer` relates to `other`. Decides whether `viewer` may see `other`'s stats. */
export async function getRelationship(viewer: ObjectId, other: ObjectId): Promise<Relationship> {
  if (viewer.equals(other)) return { kind: "self" };
  const doc = await (await getFriendshipsCollection()).findOne({ pairKey: pairKey(viewer, other) });
  if (!doc) return { kind: "none" };
  if (doc.status === "accepted") return { kind: "friends" };
  const requestId = doc._id.toHexString();
  return doc.requesterId.equals(viewer) ? { kind: "outgoing", requestId } : { kind: "incoming", requestId };
}

export async function countFriends(userId: ObjectId): Promise<number> {
  return (await getFriendshipsCollection()).countDocuments({
    $or: [{ requesterId: userId }, { recipientId: userId }],
    status: "accepted",
  });
}

/** Ends an accepted friendship. Either friend can do this; nobody else matches the pair key. */
export async function removeFriendship(me: ObjectId, other: ObjectId): Promise<boolean> {
  const result = await (await getFriendshipsCollection()).deleteOne({ pairKey: pairKey(me, other), status: "accepted" });
  return result.deletedCount === 1;
}
