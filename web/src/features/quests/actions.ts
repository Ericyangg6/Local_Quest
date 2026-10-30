"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auth } from "@/auth";
import { planQuest } from "@/lib/quest-planner";
import type { QuestPreferences } from "@/lib/quest-types";
import { checkInAtStop, deleteQuest, finishQuest, saveQuest, startQuest } from "@/lib/quests";
import { consume } from "@/lib/rate-limit";

export interface NewQuestState {
  error?: string;
  /** What the planner understood, shown when nothing fit so the player can adjust. */
  preferences?: QuestPreferences;
  /** For bug reports. */
  requestId?: string | null;
  /** The text the player sent, so the form keeps it after an error. */
  message?: string;
}

/** Each quest costs a Snowflake query and two model calls; keep one player from flooding them. */
const QUEST_REQUESTS = { limit: 10, windowMs: 10 * 60_000 };
const messageSchema = z
  .string()
  .trim()
  .min(1, "Tell us what kind of adventure you want.")
  .max(2000, "That's a bit long. Keep it under 2000 characters.");

async function currentUserId(): Promise<ObjectId | null> {
  const id = (await auth())?.user?.id;
  return id && ObjectId.isValid(id) ? new ObjectId(id) : null;
}

function field(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

const ERROR_TEXT: Record<string, string> = {
  NO_FEASIBLE_ROUTE: "", // the planner's own message explains what didn't fit
  UPSTREAM_INVALID_RESPONSE: "The planner got confused this time. Please try again.",
  UPSTREAM_UNAVAILABLE: "The quest planner is unavailable right now. Please try again in a moment.",
  UPSTREAM_TIMEOUT: "Planning took too long. Please try again.",
};

export async function generateQuest(_previous: NewQuestState, formData: FormData): Promise<NewQuestState> {
  const userId = await currentUserId();
  if (!userId) return { error: "Your session has ended. Sign in again to start a quest." };

  const raw = field(formData, "message");
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0].message, message: raw };
  const message = parsed.data;

  if (!consume(`quest-generate:${userId.toHexString()}`, QUEST_REQUESTS)) {
    return { error: "You've planned a lot of quests recently. Try again in a few minutes.", message };
  }

  const result = await planQuest(message);
  if (!result.ok) {
    return {
      error: ERROR_TEXT[result.code] || result.message,
      // Shown with "try more time or a bigger budget", so only when nothing fit.
      preferences: result.code === "NO_FEASIBLE_ROUTE" ? result.preferences : undefined,
      requestId: result.requestId,
      message,
    };
  }

  const questId = await saveQuest(userId, message, result.route);
  revalidatePath("/quests");
  redirect(`/quests/${questId}`);
}

function refreshQuestPages(questId: string) {
  revalidatePath(`/quests/${questId}`);
  revalidatePath("/quests");
  revalidatePath("/profile");
}

/** "Start quest": unlocks check-ins. Safe to repeat. */
export async function beginQuest(formData: FormData) {
  const userId = await currentUserId();
  if (!userId) return;
  const questId = field(formData, "questId");
  if (await startQuest(userId, questId)) refreshQuestPages(questId);
}

/** "Finish quest": completes it once every stop is checked in. Safe to repeat. */
export async function completeQuest(formData: FormData) {
  const userId = await currentUserId();
  if (!userId) return;
  const questId = field(formData, "questId");
  if (await finishQuest(userId, questId)) refreshQuestPages(questId);
}

/** Simulated check-in: marks one stop done. Safe to repeat. */
export async function checkIn(formData: FormData) {
  const userId = await currentUserId();
  if (!userId) return;
  const questId = field(formData, "questId");
  const stopIndex = Number(field(formData, "stopIndex"));
  if (await checkInAtStop(userId, questId, stopIndex)) refreshQuestPages(questId);
}

export async function removeQuest(formData: FormData) {
  const userId = await currentUserId();
  if (!userId) return;
  await deleteQuest(userId, field(formData, "questId"));
  revalidatePath("/quests");
  revalidatePath("/profile");
  redirect("/quests");
}
