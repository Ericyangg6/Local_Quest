import { z } from "zod";

/**
 * The quest route shape saved in MongoDB and rendered by the quest pages. Unchanged from the
 * old FastAPI response, so quests saved before the merge still parse.
 */
const locationSchema = z.object({
  name: z.string().min(1).max(300),
  address: z.string().min(1).max(300),
  closingTime: z.string().max(20),
  estimatedCost: z.number().nonnegative().optional(),
});

const taskSchema = z.object({
  id: z.enum(["photo_inside", "photo_building", "review_screenshot"]),
  text: z.string().min(1).max(200),
});

const stopSchema = z.object({
  location: locationSchema,
  arrivalTime: z.string().max(10),
  departureTime: z.string().max(10),
  travelDistance: z.number().nonnegative(),
  task: taskSchema,
  description: z.string().max(500),
});

export const questRouteSchema = z.object({
  startLocation: z.object({ address: z.string().max(300) }),
  quests: z.array(stopSchema).min(1).max(10),
  endLocation: z.object({ address: z.string().max(300) }),
  totalTime: z.number().int().nonnegative().nullish(),
  totalDistance: z.number().nonnegative().nullish(),
  estimatedCost: z.number().nonnegative(),
  mock: z.literal(true).nullish(),
});

export type QuestRoute = z.infer<typeof questRouteSchema>;
export type QuestStop = z.infer<typeof stopSchema>;
export type QuestTask = z.infer<typeof taskSchema>;

export interface QuestPreferences {
  /** Minutes for the whole outing, including the drive home. */
  desiredTime: number;
  /** US dollars. */
  desiredBudget: number;
  /** Comma-separated interests, or "random". */
  locationPreference: string;
  travelMethod: string;
}

export type PlannerErrorCode =
  | "NO_FEASIBLE_ROUTE"
  | "UPSTREAM_INVALID_RESPONSE"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export type QuestPlanResult =
  | { ok: true; route: QuestRoute; preferences: QuestPreferences }
  | {
      ok: false;
      code: PlannerErrorCode;
      /** Safe to show players. */
      message: string;
      /** Also written to the server log; quote it in bug reports. */
      requestId: string;
      /** What the planner understood from the message, once known. */
      preferences?: QuestPreferences;
    };

/** A planning failure with a player-safe message. Details go to the server log only. */
export class PlannerError extends Error {
  constructor(
    readonly code: PlannerErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}
