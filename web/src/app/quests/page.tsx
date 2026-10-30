import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ObjectId } from "mongodb";
import { auth } from "@/auth";
import { BottomNav } from "@/components/BottomNav/BottomNav";
import { QuestBoard, type QuestSummary } from "@/features/quests/QuestBoard";
import { getPlayerProfile } from "@/lib/profile";
import { getPlayerProgress, listQuests, type QuestView } from "@/lib/quests";
import "@/features/quests/quests.css";

export const metadata: Metadata = { title: "Quests · Local Quest" };

// The "Plan my quest" server action runs in this route and waits for Snowflake (place search plus two
// Cortex calls, ~15-40 s). Serverless hosts such as Vercel stop functions earlier by default, so allow
// up to 2 minutes.
export const maxDuration = 120;

function summarize(quest: QuestView): QuestSummary {
  return {
    id: quest.id,
    request: quest.request,
    stopNames: quest.route.quests.map((stop) => stop.location.name),
    stopsDone: quest.checkIns.filter(Boolean).length,
    estimatedCost: quest.route.estimatedCost,
    totalTime: quest.route.totalTime ?? null,
    mock: quest.mock,
    started: quest.startedAt !== null,
    done: quest.status === "done",
  };
}

/** Signed-in home page: the "LocalQuest quests" Figma frame. */
export default async function QuestsPage() {
  // The proxy already redirects signed-out visitors; this check covers anything it misses.
  const session = await auth();
  if (!session?.user?.id) redirect("/sign-in?callbackUrl=/quests");

  const profile = await getPlayerProfile(session.user.id);
  if (!profile) redirect("/sign-in?callbackUrl=/quests");
  const firstName = profile.displayName.split(/\s+/)[0];

  const userId = new ObjectId(session.user.id);
  const [quests, progress] = await Promise.all([listQuests(userId), getPlayerProgress(userId)]);
  const active = quests.filter((q) => q.status === "active").map(summarize);
  const done = quests.filter((q) => q.status === "done").map(summarize);

  const streakText =
    progress.dayStreak > 0
      ? `${progress.dayStreak}-day streak. Keep it going, ${firstName}!`
      : `Start a quest to begin your streak, ${firstName}!`;

  return (
    <main className="quests-page">
      <section className="quest-banner" aria-labelledby="quest-board-heading">
        <div className="quest-banner__inner">
          <div className="quest-banner__heading-row">
            <h1 className="quest-banner__heading" id="quest-board-heading">
              Your quest board
            </h1>
            <span className="quest-banner__level">LVL {progress.level}</span>
          </div>
          <p className="quest-banner__invite">Little adventures. Right here in your neighborhood.</p>
          <div className="quest-banner__progress">
            <span className="quest-banner__streak">{streakText}</span>
            <span>{progress.xp} XP</span>
          </div>
          <div
            className="quest-banner__bar"
            role="progressbar"
            aria-label="Experience"
            aria-valuenow={progress.levelPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="quest-banner__fill" style={{ width: `${progress.levelPercent}%` }} />
          </div>
        </div>
        <div className="quest-banner__ground" />
      </section>

      <QuestBoard active={active} done={done} />

      <BottomNav active="/quests" />
    </main>
  );
}
