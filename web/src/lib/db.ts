import "server-only";
import { MongoClient, type Binary, type Collection, type ObjectId } from "mongodb";
import type { AvatarContentType } from "./image-type";

/** Shape of documents in the `users` collection (shared with the Auth.js adapter). Reads add `_id`. */
export interface UserDocument {
  name?: string | null;
  email?: string | null;
  emailVerified?: Date | null;
  image?: string | null;
  /** Lowercase, unique. Absent for accounts created through Google. */
  username?: string;
  /** Argon2id hash. Absent for Google-only accounts. Never sent to the client. */
  passwordHash?: string;
  createdAt?: Date;
  /** Set when the user has uploaded a profile picture (stored in `avatars`). */
  avatarUpdatedAt?: Date;
}

/** One uploaded profile picture per user; `_id` is the user's `_id`. */
export interface AvatarDocument {
  _id: ObjectId;
  data: Binary;
  contentType: AvatarContentType;
  size: number;
  updatedAt: Date;
}

// Reuse one client across hot reloads in development and across requests in production.
const globalForMongo = globalThis as typeof globalThis & { _localQuestMongo?: Promise<MongoClient> };

export function getMongoClient(): Promise<MongoClient> {
  if (!globalForMongo._localQuestMongo) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set. See .env.example in the project folder.");
    globalForMongo._localQuestMongo = new MongoClient(url).connect().then(async (client) => {
      await ensureIndexes(client);
      return client;
    });
    // Allow a retry on the next request if the first connection fails.
    globalForMongo._localQuestMongo.catch(() => {
      globalForMongo._localQuestMongo = undefined;
    });
  }
  return globalForMongo._localQuestMongo;
}

export async function getUsersCollection(): Promise<Collection<UserDocument>> {
  const client = await getMongoClient();
  return client.db().collection<UserDocument>("users");
}

export async function getAvatarsCollection(): Promise<Collection<AvatarDocument>> {
  const client = await getMongoClient();
  return client.db().collection<AvatarDocument>("avatars");
}

/**
 * Idempotent schema setup. Collection names match the Auth.js MongoDB adapter defaults.
 * Unique indexes are what actually enforce unique usernames and emails under concurrency.
 */
async function ensureIndexes(client: MongoClient) {
  const db = client.db();
  await Promise.all([
    db.collection("users").createIndex(
      { username: 1 },
      { unique: true, partialFilterExpression: { username: { $type: "string" } }, name: "username_unique" },
    ),
    db.collection("users").createIndex(
      { email: 1 },
      { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "email_unique" },
    ),
    db.collection("accounts").createIndex(
      { provider: 1, providerAccountId: 1 },
      { unique: true, name: "provider_account_unique" },
    ),
    db.collection("accounts").createIndex({ userId: 1 }, { name: "account_user" }),
    db.collection("sessions").createIndex({ sessionToken: 1 }, { unique: true, name: "session_token_unique" }),
    db.collection("verification_tokens").createIndex(
      { identifier: 1, token: 1 },
      { unique: true, name: "verification_token_unique" },
    ),
  ]);
}
