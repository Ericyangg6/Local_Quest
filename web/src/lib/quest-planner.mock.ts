import type { PickInput, PlannerDeps } from "./quest-planner";

/**
 * Offline planner steps for local development, tests, and labeled demos (QUEST_PLANNER=mock).
 * The places are fictional; routes made with them carry `mock: true` and show a DEMO label.
 * Code still builds and checks the schedule exactly as in live mode.
 */

const CAMPUS = { latitude: 34.0565, longitude: -117.8213 };

function place(name: string, address: string, closingTime: string, estimatedCost: number, tags: string[], north: number, east: number) {
  // Offsets in miles from campus → coordinates and straight-line distance, like Snowflake's rows.
  const latitude = CAMPUS.latitude + north / 69;
  const longitude = CAMPUS.longitude + east / 57.3;
  return {
    name,
    address,
    closingTime,
    estimatedCost,
    tags,
    coordinates: { latitude, longitude },
    distance_m: Math.round(Math.hypot(north, east) * 1609.344),
    within_radius: true,
    match_reasons: [],
  };
}

export const MOCK_LOCATIONS = [
  place("Demo Bean Coffee", "101 Example Ave, Demo City, CA 90000", "18:00", 6, ["cafe", "coffee"], 0.6, 0.4),
  place("Demo Gallery of Art", "202 Sample St, Demo City, CA 90000", "17:00", 0, ["gallery", "art"], 0.9, 0.2),
  place("Demo Botanical Garden", "303 Placeholder Rd, Demo City, CA 90000", "19:00", 10, ["garden", "park"], -0.5, 0.8),
  place("Demo Used Bookshop", "404 Fixture Ln, Demo City, CA 90000", "20:00", 15, ["books"], 1.1, -0.3),
  place("Demo Taco Stand", "505 Mock Blvd, Demo City, CA 90000", "22:00", 12, ["fast_food", "taco", "food"], 0.3, -0.9),
  place("Demo History Museum", "606 Test Way, Demo City, CA 90000", "16:30", 18, ["museum", "history"], 1.4, 0.9),
  place("Demo Record Store", "707 Stub Ct, Demo City, CA 90000", "21:00", 20, ["music", "records"], -0.8, -0.6),
  place("Demo Lookout Park", "808 Dummy Dr, Demo City, CA 90000", "23:00", 0, ["park", "viewpoint"], -1.2, 0.1),
  place("Demo Ice Cream Parlor", "909 Sample St, Demo City, CA 90000", "22:30", 7, ["ice_cream", "dessert"], 0.2, 0.7),
  place("Demo Arcade", "1010 Example Ave, Demo City, CA 90000", "23:59", 25, ["arcade", "games"], -0.4, -1.3),
];

const KEYWORDS = ["coffee", "art", "garden", "park", "book", "food", "taco", "museum", "history", "music", "record", "ice cream", "arcade", "game"];
const HOURS = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/;
const MINUTES = /(\d+)\s*(?:minutes?|mins?)\b/;
const DOLLARS = /\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars|bucks)/;

function pickStops({ candidates, preferences, tasks }: PickInput) {
  const interests = preferences.locationPreference.toLowerCase().split(", ");
  const matches = (tags: string[]) => tags.some((tag) => interests.some((i) => tag.includes(i) || i.includes(tag)));
  const ordered = [...candidates.filter((c) => matches(c.categories)), ...candidates.filter((c) => !matches(c.categories))];
  return {
    stops: ordered.slice(0, 3).map((c, i) => ({
      id: c.id,
      description: `[Demo] Stop ${i + 1}: drive to ${c.name}. Your task: ${tasks.get(c.id)?.text ?? "explore"}.`,
    })),
  };
}

export const mockPlannerDeps: PlannerDeps = {
  mock: true,
  async extractPreferences(message) {
    const text = message.toLowerCase();
    const hours = HOURS.exec(text);
    const minutes = MINUTES.exec(text);
    const dollars = DOLLARS.exec(text);
    const interests = KEYWORDS.filter((k) => text.includes(k));
    return {
      desiredTime: hours ? Number(hours[1]) * 60 : minutes ? Number(minutes[1]) : null,
      desiredBudget: dollars ? Number(dollars[1] ?? dollars[2]) : null,
      locationPreference: interests.length ? interests.join(", ") : null,
    };
  },
  async findLocations() {
    return { locations: MOCK_LOCATIONS };
  },
  async pickStops(input) {
    return pickStops(input);
  },
};
