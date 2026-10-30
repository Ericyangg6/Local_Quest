import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAMPUS_ADDRESS,
  DEFAULT_PREFERENCES,
  QUEST_TASKS,
  buildSchedule,
  extractJson,
  normalizePreferences,
  parseCandidates,
  planQuest,
  plannerDepsFromEnv,
  proveInfeasible,
  type Candidate,
  type PlannerDeps,
} from "./quest-planner";
import { MOCK_LOCATIONS, mockPlannerDeps } from "./quest-planner.mock";
import { PlannerError, questRouteSchema, type QuestPreferences } from "./quest-types";

vi.spyOn(console, "info").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const PREFS: QuestPreferences = { desiredTime: 120, desiredBudget: 30, locationPreference: "coffee, art", travelMethod: "drive" };

function candidate(id: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    name: `Place ${id}`,
    address: `${id} Main St, Pomona, CA 91768`,
    closingTime: "20:00",
    estimatedCost: 5,
    distanceMiles: 1,
    coordinates: null,
    categories: [],
    preferenceMatches: [],
    interestMatches: [],
    rank: id,
    withinRange: true,
    ...overrides,
  };
}

function schedule(picks: unknown, candidates: Candidate[], prefs = PREFS, startTime = "10:00") {
  const tasks = new Map(candidates.map((c) => [c.id, QUEST_TASKS[0]]));
  return buildSchedule(picks, { candidates, preferences: prefs, startTime, tasks });
}

describe("normalizePreferences", () => {
  it("defaults missing or invalid values to 90 minutes, $30, and no preference", () => {
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences({ desiredTime: -5, desiredBudget: "lots", locationPreference: "" })).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences({ desiredTime: 99999, desiredBudget: 1e9 })).toEqual(DEFAULT_PREFERENCES);
  });

  it("keeps valid overrides, including $0 and unit strings", () => {
    expect(normalizePreferences({ desiredTime: "120 min", desiredBudget: "$0", locationPreference: "parks" })).toEqual({
      desiredTime: 120,
      desiredBudget: 0,
      locationPreference: "parks",
      travelMethod: "drive",
    });
  });

  it("splits interests on and/or/& and removes repeats", () => {
    expect(normalizePreferences({ locationPreference: "coffee and art & Coffee or pizza" }).locationPreference).toBe("coffee, art, pizza");
  });

  it("always plans for driving", () => {
    expect(normalizePreferences({ travelMethod: "walk" }).travelMethod).toBe("drive");
  });
});

describe("parseCandidates", () => {
  it("reads Snowflake rows with upper-case keys and numeric strings", () => {
    const { candidates, issues } = parseCandidates({
      LOCATIONS: [{ NAME: "Cafe", ADDRESS: "1 A St", CLOSINGTIME: "21:00:00", ESTIMATEDCOST: "4.5", DISTANCE_M: 1609.344, TAGS: ["cafe"] }],
    });
    expect(issues).toEqual([]);
    expect(candidates[0]).toMatchObject({ id: 1, name: "Cafe", closingTime: "21:00", estimatedCost: 4.5, distanceMiles: 1, categories: ["cafe"] });
  });

  it("skips duplicates, bad costs, and rows without a closing time, and keeps at most 10", () => {
    const rows = [
      { name: "A", address: "1 St", closingTime: "20:00" },
      { name: "a", address: "1  st", closingTime: "20:00" },
      { name: "B", address: "2 St", closingTime: "20:00", estimatedCost: -1 },
      { name: "C", address: "3 St" },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, address: `${i} Rd`, closingTime: "20:00" })),
    ];
    const { candidates, issues } = parseCandidates(rows);
    expect(candidates).toHaveLength(10);
    expect(candidates.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(issues).toHaveLength(3);
  });

  it("rejects a payload that isn't a list", () => {
    expect(() => parseCandidates("not json")).toThrow(PlannerError);
    expect(() => parseCandidates({ rows: [] })).toThrow(PlannerError);
  });
});

describe("proveInfeasible", () => {
  it("reports when every place is already closed", () => {
    expect(proveInfeasible([candidate(1, { closingTime: "09:00" })], "10:00", 30)?.reason).toBe("ALL_CLOSED");
  });

  it("treats an early-morning closing time as after midnight", () => {
    expect(proveInfeasible([candidate(1, { closingTime: "01:30" })], "22:00", 30)).toBeNull();
  });

  it("reports when nothing open has a known cost within budget", () => {
    expect(proveInfeasible([candidate(1, { estimatedCost: 50 }), candidate(2, { estimatedCost: null })], "10:00", 30)?.reason).toBe(
      "NONE_WITHIN_BUDGET",
    );
  });
});

describe("buildSchedule", () => {
  it("computes times, distances, and cost in code, in the model's order", () => {
    const { route, dropped } = schedule({ stops: [{ id: 2, description: "Second" }, { id: 1, description: "First" }] }, [
      candidate(1),
      candidate(2),
    ]);
    expect(dropped).toEqual([]);
    expect(route?.quests.map((q) => q.location.name)).toEqual(["Place 2", "Place 1"]);
    // 1 mi straight line × 1.3 at 25 mph ≈ 3 min; no coordinates, so stop to stop goes via the start (2.6 mi ≈ 6 min).
    expect(route?.quests.map((q) => [q.arrivalTime, q.departureTime])).toEqual([
      ["10:03", "10:23"],
      ["10:29", "10:49"],
    ]);
    expect(route).toMatchObject({ totalTime: 52, totalDistance: 5.2, estimatedCost: 10, startLocation: { address: CAMPUS_ADDRESS } });
    expect(questRouteSchema.safeParse(route).success).toBe(true);
  });

  it("drops unknown, repeated, unpriced, over-budget, closing, and too-long stops", () => {
    const candidates = [
      candidate(1, { estimatedCost: 25 }),
      candidate(2, { estimatedCost: null }),
      candidate(3, { estimatedCost: 10 }),
      candidate(4, { closingTime: "10:10" }),
      candidate(5, { distanceMiles: 40 }),
      candidate(6),
    ];
    const { route, dropped } = schedule({ stops: [1, 1, 99, 2, 3, 4, 5, 6].map((id) => ({ id })) }, candidates);
    expect(route?.quests.map((q) => q.location.name)).toEqual(["Place 1", "Place 6"]);
    expect(dropped).toEqual([
      "#1 repeated",
      "#99 is not a candidate",
      "#2 has no known cost",
      "#3 over budget",
      "#4 closes at 10:10",
      "#5 doesn't fit the time limit",
    ]);
  });

  it("counts the drive home against the time limit", () => {
    const { route } = schedule({ stops: [{ id: 1 }] }, [candidate(1, { distanceMiles: 5 })], { ...PREFS, desiredTime: 45 });
    // 6.5 road miles ≈ 16 min each way + 20 min visit = 52 min > 45.
    expect(route).toBeNull();
  });

  it("uses coordinates between stops when known", () => {
    const here = { latitude: 34.05, longitude: -117.82 };
    const { route } = schedule({ stops: [{ id: 1 }, { id: 2 }] }, [
      candidate(1, { coordinates: here }),
      candidate(2, { coordinates: { latitude: 34.05, longitude: -117.82 } }),
    ]);
    expect(route?.quests[1].travelDistance).toBe(0);
  });

  it("replaces missing or overlong descriptions with template text", () => {
    const { route } = schedule({ stops: [{ id: 1 }, { id: 2, description: "x".repeat(501) }] }, [candidate(1), candidate(2)]);
    for (const stop of route!.quests) expect(stop.description).toMatch(/^Stop by Place \d at .* Your task: Take a picture of the inside\.$/);
  });

  it("ignores a reply that has no stops", () => {
    expect(schedule("nonsense", [candidate(1)]).route).toBeNull();
    expect(schedule({ stops: [{ id: "one" }] }, [candidate(1)]).route).toBeNull();
  });
});

describe("extractJson", () => {
  it("reads JSON inside fences or prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} Hope that helps')).toEqual({ a: 2 });
    expect(extractJson("no json")).toBeNull();
  });
});

describe("planQuest", () => {
  const now = new Date("2026-10-30T17:00:00Z"); // 10:00 in Pomona
  const options = { deps: mockPlannerDeps, now, random: () => 0, timeZone: "America/Los_Angeles" };

  it("plans a labeled demo quest in mock mode", async () => {
    const result = await planQuest("2 hours and $25, coffee and art", options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preferences).toMatchObject({ desiredTime: 120, desiredBudget: 25, locationPreference: "coffee, art" });
    expect(result.route.mock).toBe(true);
    expect(result.route.quests[0].location.name).toBe("Demo Bean Coffee");
    expect(result.route.estimatedCost).toBeLessThanOrEqual(25);
    expect(result.route.totalTime).toBeLessThanOrEqual(120);
    expect(questRouteSchema.safeParse(result.route).success).toBe(true);
    expect(MOCK_LOCATIONS.map((l) => l.name)).toEqual(expect.arrayContaining(result.route.quests.map((q) => q.location.name)));
  });

  it("returns a proven NO_FEASIBLE_ROUTE without asking the model to pick stops", async () => {
    const pickStops = vi.fn();
    const deps: PlannerDeps = { ...mockPlannerDeps, pickStops };
    const result = await planQuest("anything", { ...options, deps, now: new Date("2026-10-31T06:59:30Z") }); // 23:59, everything has closed
    expect(result).toMatchObject({ ok: false, code: "NO_FEASIBLE_ROUTE" });
    expect(pickStops).not.toHaveBeenCalled();
  });

  it("returns NO_FEASIBLE_ROUTE with the understood preferences when no pick fits", async () => {
    const deps: PlannerDeps = { ...mockPlannerDeps, pickStops: async () => ({ stops: [{ id: 42 }] }) };
    const result = await planQuest("30 minutes", { ...options, deps });
    expect(result).toMatchObject({ ok: false, code: "NO_FEASIBLE_ROUTE", preferences: { desiredTime: 30 } });
  });

  it("passes on Snowflake errors with a player-safe message", async () => {
    const deps: PlannerDeps = {
      ...mockPlannerDeps,
      findLocations: async () => {
        throw new PlannerError("UPSTREAM_TIMEOUT", "Planning took too long. Please try again.");
      },
    };
    const result = await planQuest("coffee", { ...options, deps });
    expect(result).toMatchObject({ ok: false, code: "UPSTREAM_TIMEOUT", preferences: { locationPreference: "coffee" } });
    if (!result.ok) expect(result.requestId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("hides unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    const deps: PlannerDeps = { ...mockPlannerDeps, extractPreferences: async () => Promise.reject(new Error("secret detail")) };
    const result = await planQuest("coffee", { ...options, deps });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." });
  });
});

describe("plannerDepsFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to mock outside production", () => {
    vi.stubEnv("QUEST_PLANNER", "");
    expect(plannerDepsFromEnv().mock).toBe(true);
  });

  it("refuses mock in production unless allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QUEST_PLANNER", "mock");
    expect(() => plannerDepsFromEnv()).toThrow(PlannerError);
    vi.stubEnv("ALLOW_MOCK_IN_PRODUCTION", "true");
    expect(plannerDepsFromEnv().mock).toBe(true);
  });

  it("rejects an unknown mode and selects snowflake", () => {
    vi.stubEnv("QUEST_PLANNER", "cursor");
    expect(() => plannerDepsFromEnv()).toThrow(PlannerError);
    vi.stubEnv("QUEST_PLANNER", "snowflake");
    expect(plannerDepsFromEnv().mock).toBe(false);
  });
});
