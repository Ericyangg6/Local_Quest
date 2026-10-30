import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ObjectId } from "mongodb";
import { auth } from "@/auth";
import { BottomNav } from "@/components/BottomNav/BottomNav";
import { beginQuest, checkIn, completeQuest, removeQuest } from "@/features/quests/actions";
import { getQuest } from "@/lib/quests";
import "@/features/quests/quests.css";

export const metadata: Metadata = { title: "Quest · Local Quest" };

/** One saved quest: the route from campus through each stop and back, with simulated check-ins. */
export default async function QuestPage({ params }: { params: Promise<{ questId: string }> }) {
  const { questId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect(`/sign-in?callbackUrl=/quests/${encodeURIComponent(questId)}`);

  // getQuest only returns quests owned by this user; anyone else gets a 404.
  const quest = await getQuest(new ObjectId(session.user.id), questId);
  if (!quest) notFound();

  const { route } = quest;
  const stopsDone = quest.checkIns.filter(Boolean).length;
  const done = quest.status === "done";
  const started = quest.startedAt !== null;
  const allCheckedIn = stopsDone === route.quests.length;

  return (
    <main className="quests-page">
      <section className="quest-banner" aria-labelledby="quest-heading">
        <div className="quest-banner__inner">
          <div className="quest-banner__heading-row">
            <h1 className="quest-banner__heading" id="quest-heading">
              {done ? "Quest complete!" : started ? "Quest in progress" : "Your quest"}
            </h1>
            {quest.mock && <span className="quest-banner__level">DEMO</span>}
          </div>
          <p className="quest-banner__invite">“{quest.request}”</p>
          <div className="quest-banner__progress">
            <span className="quest-banner__streak">
              {stopsDone} of {route.quests.length} stops checked in
            </span>
            <span>est. ${route.estimatedCost.toFixed(2)}</span>
          </div>
          <div
            className="quest-banner__bar"
            role="progressbar"
            aria-label="Quest progress"
            aria-valuenow={stopsDone}
            aria-valuemin={0}
            aria-valuemax={route.quests.length}
          >
            <div className="quest-banner__fill" style={{ width: `${Math.round((stopsDone / route.quests.length) * 100)}%` }} />
          </div>
        </div>
        <div className="quest-banner__ground" />
      </section>

      <div className="quest-board">
        <Link className="quest-back" href="/quests">
          ← Back to quest board
        </Link>

        {quest.mock && (
          <p className="quest-note quest-note__text">
            Demo data: these places and times come from the planner&apos;s mock mode, not Snowflake.
          </p>
        )}

        {!started && !done && (
          <form action={beginQuest} className="quest-action">
            <input type="hidden" name="questId" value={quest.id} />
            <button type="submit" className="new-quest__submit quest-action__button">
              Start quest
            </button>
            <p className="quest-note__text">Head to the start, press Start, then check in at each stop.</p>
          </form>
        )}

        <ol className="quest-route" aria-label="Route">
          <li className="quest-route__point">
            <span className="quest-route__marker">Start</span>
            <span>{route.startLocation.address}</span>
          </li>

          {route.quests.map((stop, i) => {
            const checkedInAt = quest.checkIns[i];
            return (
              <li key={i} className={`quest-stop${checkedInAt ? " quest-stop--done" : ""}`}>
                <p className="quest-stop__travel">
                  {stop.travelDistance.toFixed(1)} mi drive from the previous point
                </p>
                <div className="quest-card">
                  <div className="quest-card__top">
                    <h2 className="quest-card__title">
                      {i + 1}. {stop.location.name}
                    </h2>
                    {checkedInAt && <span className="stamp-badge">Stamped</span>}
                  </div>
                  <p className="quest-card__text">{stop.location.address}</p>
                  <p className="quest-stop__times">
                    {stop.arrivalTime}–{stop.departureTime} · closes {stop.location.closingTime}
                    {stop.location.estimatedCost !== undefined && ` · est. $${stop.location.estimatedCost.toFixed(2)}`}
                  </p>
                  <p className="quest-stop__description">{stop.description}</p>
                  <p className="quest-stop__task">
                    <strong>Task:</strong> {stop.task.text}
                  </p>
                  {checkedInAt ? (
                    <p className="quest-stop__checked">Checked in (simulated)</p>
                  ) : !started || done ? (
                    <p className="quest-stop__checked">{done ? "Not checked in" : "Start the quest to check in"}</p>
                  ) : (
                    <form action={checkIn}>
                      <input type="hidden" name="questId" value={quest.id} />
                      <input type="hidden" name="stopIndex" value={i} />
                      <button type="submit" className="new-quest__submit">
                        Check in (simulated)
                      </button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}

          <li className="quest-route__point">
            <span className="quest-route__marker">Finish</span>
            <span>{route.endLocation.address}</span>
          </li>
        </ol>

        {started && !done && (
          <form action={completeQuest} className="quest-action">
            <input type="hidden" name="questId" value={quest.id} />
            <button type="submit" className="new-quest__submit quest-action__button" disabled={!allCheckedIn}>
              Finish quest
            </button>
            <p className="quest-note__text">
              {allCheckedIn
                ? "Every stop is stamped. Finish to collect your XP."
                : `Check in at ${route.quests.length - stopsDone} more ${route.quests.length - stopsDone === 1 ? "stop" : "stops"} to finish.`}
            </p>
          </form>
        )}
        {done && quest.completedAt && (
          <p className="quest-note__text">Finished {quest.completedAt.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}.</p>
        )}

        <p className="quest-note__text">
          {route.totalTime ? `About ${route.totalTime} min` : "Time not estimated"}
          {route.totalDistance ? ` · about ${route.totalDistance.toFixed(1)} mi total` : ""}. Costs are typical-spend
          estimates by place type; travel times and distances are the planner&apos;s estimates. Check-ins are
          simulated and don&apos;t verify a visit or purchase.
        </p>

        <form action={removeQuest}>
          <input type="hidden" name="questId" value={quest.id} />
          <button type="submit" className="quest-remove">
            Remove this quest
          </button>
        </form>
      </div>

      <BottomNav active="/quests" />
    </main>
  );
}
