import { sameLoginTarget, syncRecipeIdSchema, type LoginStep } from "@pateat/contracts";
import * as v from "valibot";
import { loginReadiness, type StartMiss } from "./wire";

// Repairing a generated recipe whose start page no longer matches it (ADR 0041):
// which misses count, and how a device holds a recipe whose repair the service already
// answered today.

/**
 * What one start page's miss says about its recipe: `stale` when it is sent for repair;
 * otherwise why not. `status` for a document whose load the server answered with an error
 * status, as a maintenance page on the login page's URL; `unusable` when a first step's
 * elements were all found but cannot be used yet, as on a slow page; `no-detail` when the
 * page did not say what it missed.
 */
export type StartMissVerdict = "stale" | "status" | "unusable" | "no-detail";

/**
 * Whether a recipe's start page, which showed a sign-in input for the step wait without a
 * ready first step, counts as stale. `firstSteps` are the recipe's first steps on the page's
 * path, of every route and variant: one whose targets were all found, only not usable yet,
 * makes the miss `unusable`. A page in another language than the recipe's, or a reworded
 * button, counts: the repair adds a layout for it beside the one that still works.
 */
export function classifyStartMiss(
  firstSteps: readonly LoginStep[],
  miss: StartMiss | undefined,
): StartMissVerdict {
  if (!miss) return "no-detail";
  if (miss.status !== undefined && (miss.status < 200 || miss.status > 299)) return "status";
  // Past the list's limit, the content script's own answer stands.
  const found = miss.more
    ? miss.found === true
    : firstSteps.some((step) =>
        loginReadiness(step).targets.every(
          (target) => !miss.missing.some((other) => sameLoginTarget(other, target)),
        ),
      );
  return found ? "unusable" : "stale";
}

/** Recipes whose repairs are remembered at once; the least recently repaired go first. */
export const MAX_REPAIR_ENTRIES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (at: number) => Math.floor(at / DAY_MS);

const repairsSchema = v.strictObject({
  version: v.literal(1),
  recipes: v.pipe(
    v.array(
      v.strictObject({
        recipeId: syncRecipeIdSchema,
        revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
        /** The document whose start page was last sent, so it is sent once. */
        documentId: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
        /** When the service last answered a repair of this recipe without a new revision. */
        held: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      }),
    ),
    v.maxLength(MAX_REPAIR_ENTRIES),
  ),
});
type RepairRecords = v.InferOutput<typeof repairsSchema>;
type RepairRecord = RepairRecords["recipes"][number];

export interface RepairStorage {
  read(): Promise<unknown>;
  write(value: RepairRecords): Promise<void>;
}

/**
 * Whether a stale start page is sent: `due` now, `held` when the service already answered
 * a repair of the recipe this UTC day, `repeat` for a document already sent, and
 * `unavailable` when the record could not be read or written.
 */
export type RepairNote = "due" | "held" | "repeat" | "unavailable";

export interface RecipeRepairs {
  /** Claims one document's stale start page of a recipe revision for its repair. */
  due(entry: { recipeId: string; revision: number; documentId: string }): Promise<RepairNote>;
  /**
   * The service answered a repair of the recipe without a new revision (it abstained,
   * kept the layouts or refused for the day's limit), so it is held until the next UTC day.
   */
  hold(recipeId: string): Promise<void>;
}

/**
 * The repairs of generated recipes' start pages on this device, kept across service worker
 * restarts. Stored records that do not parse count as none.
 */
export function createRecipeRepairs(
  storage: RepairStorage,
  now: () => number = Date.now,
): RecipeRepairs {
  let queue: Promise<unknown> = Promise.resolve();
  function update<T>(change: (records: RepairRecord[]) => { records?: RepairRecord[]; result: T }) {
    const next = queue.then(async () => {
      const parsed = v.safeParse(repairsSchema, await storage.read());
      const { records, result } = change(parsed.success ? parsed.output.recipes : []);
      if (records) await storage.write({ version: 1, recipes: records.slice(-MAX_REPAIR_ENTRIES) });
      return result;
    });
    queue = next.catch(() => undefined);
    return next;
  }
  const without = (records: RepairRecord[], recipeId: string) =>
    records.filter((entry) => entry.recipeId !== recipeId);
  return {
    due({ recipeId, revision, documentId }) {
      return update<RepairNote>((records) => {
        const before = records.find((entry) => entry.recipeId === recipeId);
        if (before?.documentId === documentId && before.revision === revision)
          return { result: "repeat" };
        if (before?.held !== undefined && utcDay(before.held) === utcDay(now()))
          return { result: "held" };
        return {
          records: [...without(records, recipeId), { recipeId, revision, documentId }],
          result: "due",
        };
      }).catch(() => "unavailable" as const);
    },
    async hold(recipeId) {
      await update((records) => {
        const before = records.find((entry) => entry.recipeId === recipeId);
        if (!before) return { result: undefined };
        return {
          records: [...without(records, recipeId), { ...before, held: now() }],
          result: undefined,
        };
      }).catch(() => undefined);
    },
  };
}
